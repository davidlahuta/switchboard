import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { DAEMON_URL, HOME_CLAUDE_DIR } from '../config.ts';
import { logger } from '../log.ts';
import { tabTitle } from '../shared/marks.ts';
import type { DaemonToRunner, ManualRunSpec, RunnerToDaemon, SpawnSpec } from '../shared/protocol.ts';
import type { AgentStatus, Attention, CreateRunRequest, Run, RunStatus, Subscription, Swap, TermClientFrame } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import { claudeCommand, findClaude, hooksConfig, mcpServerEntry, projectSlug, writeRuntimeJson } from './claude.ts';
import type { Coordinator } from './coord.ts';
import { bool, type Db, now } from './db.ts';
import { newestSourceMtime } from './source.ts';
import { readCustomTitle, readSessionModel } from './transcript.ts';
import { hooksInstalledIn } from './integration.ts';
import type { Launcher } from './launcher.ts';
import { TermMirror } from './mirror.ts';
import type { ModelCatalog } from './models.ts';
import { getSettings } from './settings.ts';
import { SPENT_PCT, SWAP_MARGIN, type SubscriptionManager } from './subscriptions.ts';

const log = logger('runs');

interface RunRow {
  id: string;
  name: string;
  cwd: string;
  last_cwd: string | null;
  repo_id: string | null;
  session_id: string;
  subscription_id: string;
  status: RunStatus;
  auto_swap: number;
  swap_count: number;
  worktree: string | null;
  resume: number;
  resuming: string | null;
  pid: number | null;
  cols: number;
  rows: number;
  created_at: string;
  ended_at: string | null;
  exit_code: number | null;
  extra_args: string | null;
  version: string | null;
  model: string | null;
  auto_compact: number | null;
  auto_compact_tokens: number | null;
  skip_permissions: number | null;
  claude_title: string | null;
  continue_on_resume: number | null;
  last_viewed_at: string | null;
}

/** A respawn waiting for the session to finish its turn. */
interface PendingRespawn {
  /** subscription to come back on; equal to the current one for a plain restart */
  target: string;
  reason: string;
  continueAfter: boolean;
  kind: 'swap' | 'restart';
  queuedAt: number;
  /**
   * When to stop waiting for the turn to end and take the session anyway, or null to wait however
   * long the turn takes. Only a session that cannot make progress where it is gets a deadline.
   */
  deadline: number | null;
}

const LIVE: RunStatus[] = ['starting', 'running', 'swapping', 'disconnected'];
const CONTINUE_DELAY_MS = 2500;
/** Without a hook to say the session is at a prompt, long enough for it to have got there. */
const CONTINUE_SPAWN_DELAY_MS = 9000;
/**
 * A confirmation waiting for an answer. Claude Code footers every one of them with this, and the
 * option it starts on is often the one that exits — so nothing may be typed while it is on screen.
 */
const CONFIRM_FOOTER = /Enter\s*to\s*confirm/i;
const CONTINUE_RETRY_MS = 4000;
const CONTINUE_RETRIES = 15;
const CONTINUE_FALLBACK_MS = 25_000;
/** How long before a session that is still limited is offered another way out. */
const RESCUE_DEBOUNCE_MS = 60_000;
/**
 * What a session is told when the swap could not wait for the end of its turn. "continue" on its
 * own invites it to carry on from a plan whose later half never ran: the tools it called last may
 * have finished, been killed halfway, or never started, and any subagents went down with the
 * process. It has to look before it trusts the transcript.
 */
const INTERRUPTED_MESSAGE =
  'Your previous turn was cut short mid-way by Switchboard moving this session to another subscription. Anything still running at that moment, subagents included, was killed with it. Check what actually landed on disk before you trust the last part of the transcript, then carry on.';
const LIMIT_DEBOUNCE_MS = 90_000;
/**
 * How long a session that has run into its subscription's limit is left alone before it is moved
 * regardless. It cannot get much further where it is — the next call fails the same way — but a turn
 * is rarely only API calls, and this is enough for a build, a test run or a subagent's last write to
 * land on disk rather than being killed halfway.
 */
const LIMIT_GRACE_MS = 3 * 60_000;

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

/**
 * Which side renamed the session. `shadow` is the last title the session reported, so it differing
 * from what the session reports now means the rename happened in there (/rename, or the title
 * Claude generates from a first prompt) and Switchboard follows. Otherwise a name that has moved
 * away from the shadow is the operator's, and it goes the other way. Exported for tests.
 */
/**
 * Whether a session in this state can be killed and resumed without costing anything.
 *
 * The test is that it is positively known to be at a prompt, not that it fails to look busy. A turn
 * can run for an hour — subagents, a long build — with no hook firing for any of it, so a session
 * waiting at a permission prompt, one still starting, and one the liveness sweep gave up on after
 * three hours of silence all read from here exactly like one that has finished. Killing any of the
 * three costs a turn; waiting costs a swap that happens a few minutes later instead.
 *
 * A session with no agent record ran no hooks at all, so nothing here can speak for it: it swaps.
 * 'limited' has already lost its turn to the subscription, which is what the swap is there to fix.
 */
/**
 * How hard to insist on moving a session that has run into its subscription's limit.
 *
 * A rate limit reported through StopFailure has already ended the turn: there is nothing left to
 * interrupt, so the session moves at once. The same limit noticed in the terminal's output says
 * nothing about the turn — a subagent may have hit it while the parent carries on, or Claude Code
 * may be between retries — and killing that costs whatever the turn had built up. So that one is
 * queued behind the turn, with a deadline: the session cannot get far on a spent subscription, but
 * its build, test run or half-written file is given time to land.
 */
export function limitSwapPlan(source: 'hook' | 'pty', now = Date.now()): { force: boolean; deadline: number | null } {
  return source === 'hook' ? { force: true, deadline: null } : { force: false, deadline: now + LIMIT_GRACE_MS };
}

/**
 * Whether a session is asking to be looked at.
 *
 * Three separable things, because they answer differently. `waiting` is Claude Code stopped on a
 * prompt only a person can clear, and nothing else moves until it is. `unread` is the session
 * having deliberately addressed the operator with sb_send. `unseen` is softer: it has done
 * something, it is not still going, and its terminal has not been open since — a finished turn
 * nobody has read.
 *
 * A session mid-turn is deliberately not unseen. It will finish, and a dot on everything that is
 * merely busy is a dot that stops being worth looking at.
 */
export function attentionFor(input: {
  agentStatus: AgentStatus | null;
  lastActivity: string;
  lastViewedAt: string | null;
  unread: number;
}): Attention {
  const busy = input.agentStatus === 'working' || input.agentStatus === 'starting';
  return {
    waiting: input.agentStatus === 'waiting',
    unread: input.unread,
    unseen: !busy && (!input.lastViewedAt || input.lastActivity > input.lastViewedAt),
  };
}

/**
 * What to do with a session that stopped on a usage limit, now that usage has been read again.
 *
 * The proactive threshold answers "is somewhere else enough better to be worth a swap", and for a
 * session that is running that is the right question. For one that has stopped it is the wrong one
 * twice over: its own subscription coming back is not a swap at all, it is a session that can be
 * told to carry on; and anywhere with capacity beats where it is, because where it is has none.
 * Holding a stopped session to a threshold meant for a running one is how it sat out somebody
 * else's reset.
 */
export function rescueDecision(input: { ownUsedPct: number; bestElsewherePct: number | null; threshold: number }): 'continue' | 'move' | 'wait' {
  if (input.ownUsedPct < input.threshold) return 'continue';
  if (input.bestElsewherePct !== null && input.bestElsewherePct < SPENT_PCT) return 'move';
  return 'wait';
}

export function safeToRespawn(status: AgentStatus | undefined): boolean {
  return status === undefined || status === 'idle' || status === 'limited';
}

export function titleDecision(name: string, shadow: string | null, reported: string | null): { adopt?: string; push?: string } {
  const title = reported?.trim() || null;
  // Adopting a title that already matches the name is a no-op rename that records the shadow, so
  // the two stop looking out of step.
  if (title && title !== shadow) return { adopt: title };
  if (name === shadow) return {};
  return { push: name };
}

/**
 * What to do with the session id a hosted process reports for itself.
 *
 * A session may legitimately change id under us — `/clear` starts a new conversation in the same
 * terminal — and the run has to follow it, or Switchboard is holding a pointer to a conversation
 * nobody is in. But a process that was launched with `--resume` has one right answer, and Claude
 * Code does not always fail loudly when it cannot give it: a transcript it finds but cannot load
 * gets a "Failed to resume session" line and then a brand-new conversation with an id of its own.
 * Adopting that id overwrites the only pointer the run holds to the conversation it was resuming.
 *
 * So `wanted` — the id this process was told to resume, until it confirms it — outranks adoption.
 */
export function rebindDecision(current: string, reported: string, wanted: string | null): 'ignore' | 'adopt' | 'lost' {
  if (reported === current) return 'ignore';
  if (wanted !== null && reported !== wanted) return 'lost';
  return 'adopt';
}

function parseArgs(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Arguments Switchboard owns. Letting a session override them would break the thing that makes it
 * a *hosted* session: identity, coordination and the ability to resume it elsewhere.
 */
const RESERVED_ARGS = new Set(['--session-id', '--resume', '-r', '--continue', '-c', '--mcp-config', '--settings', '--worktree', '-w', '--from-pr', '--teleport']);
/** Arguments that have their own control in the dialog, to keep one setting in one place. */
const DUPLICATED_ARGS = new Map([
  ['--model', 'the model select'],
  ['--dangerously-skip-permissions', 'the "skip permission prompts" checkbox'],
  ['--name', 'the name field'],
]);

export function rejectReservedArgs(args: string[]): void {
  const flags = args.map((a) => a.split('=')[0]);
  const bad = flags.filter((a) => RESERVED_ARGS.has(a));
  if (bad.length) {
    throw httpError(
      400,
      `Switchboard manages ${[...new Set(bad)].join(', ')} for hosted sessions. Use the session and worktree fields instead of passing them as arguments.`,
    );
  }
  const duplicated = flags.find((a) => DUPLICATED_ARGS.has(a));
  if (duplicated) throw httpError(400, `Set ${duplicated} with ${DUPLICATED_ARGS.get(duplicated)} rather than as an argument, so it is not applied twice.`);
}

export class RunManager {
  private readonly db: Db;
  private readonly bus: Bus;
  private readonly subs: SubscriptionManager;
  private readonly coord: Coordinator;
  private readonly launcher: Launcher;
  private readonly models: ModelCatalog;
  private readonly conns = new Map<string, WebSocket>();
  private readonly mirrors = new Map<string, TermMirror>();
  private readonly pendingRespawn = new Map<string, PendingRespawn>();
  /**
   * The size a browser asked for, per run, so a runner that was not there to hear it can be told.
   * Opening a session from the web is precisely that case: the terminal page asks for its size
   * while the terminal window is still opening, and the runner it is meant for does not exist yet.
   */
  private readonly webSize = new Map<string, { cols: number; rows: number }>();
  /**
   * Unread counts for the whole board, refreshed at most once a second. A state snapshot renders
   * every session at once, and one grouped query for all of them beats one query each.
   */
  private operatorUnread: { at: number; by: Map<string, number> } | null = null;
  /** Set by the daemon once the updater knows which claude version is installed. */
  versionProvider: () => string | null = () => null;
  private readonly pendingContinue = new Map<string, { text: string; timer: NodeJS.Timeout }>();
  /** When each session was last picked up off a limit, so a poll every few seconds does it once. */
  private readonly lastRescue = new Map<string, number>();
  private readonly lastLimit = new Map<string, number>();

  constructor(db: Db, bus: Bus, subs: SubscriptionManager, coord: Coordinator, launcher: Launcher, models: ModelCatalog) {
    this.db = db;
    this.bus = bus;
    this.subs = subs;
    this.coord = coord;
    this.launcher = launcher;
    this.models = models;
    this.loadPending();
  }

  start(): void {
    this.db.run("UPDATE runs SET status = 'disconnected' WHERE status IN ('starting', 'running', 'swapping')");
    this.subs.liveRunsFor = (id) => this.liveCount(id);
    this.subs.onUsage = (s) => this.onUsage(s);
  }

  // ---------------------------------------------------------------- reads

  row(id: string): RunRow | undefined {
    return this.db.get<RunRow>('SELECT * FROM runs WHERE id = ?', id);
  }

  bySession(sessionId: string): RunRow | undefined {
    return this.db.get<RunRow>("SELECT * FROM runs WHERE session_id = ? AND status <> 'exited' ORDER BY created_at DESC LIMIT 1", sessionId);
  }

  /**
   * Whether a session Switchboard hosts is over. The board otherwise has to infer death from
   * silence, and silence is exactly what an idle session at a prompt produces — so a session that
   * really ended can sit on the board holding an exclusive claim long after there is anyone behind
   * it. A session with no run here is not Switchboard's to speak for, and answers false.
   */
  sessionOver(sessionId: string): boolean {
    const rows = this.db.all<{ status: RunStatus }>('SELECT status FROM runs WHERE session_id = ?', sessionId);
    return rows.length > 0 && rows.every((r) => r.status === 'exited');
  }

  liveCount(subscriptionId?: string): number {
    const placeholders = LIVE.map(() => '?').join(', ');
    const sql = `SELECT COUNT(*) AS n FROM runs WHERE status IN (${placeholders})${subscriptionId ? ' AND subscription_id = ?' : ''}`;
    const params = subscriptionId ? [...LIVE, subscriptionId] : LIVE;
    return this.db.get<{ n: number }>(sql, ...params)?.n ?? 0;
  }

  /** When each attached runner process was started, for staleRunner. */
  private readonly runnerStartedAt = new Map<string, number>();
  /** Runs waiting for their terminal to close so a fresh one can be opened for them. */
  private readonly relaunching = new Set<string>();

  private runnerStale(runId: string): boolean {
    const started = this.runnerStartedAt.get(runId);
    return started !== undefined && newestSourceMtime() > started;
  }

  private dto(r: RunRow): Run {
    const swap = this.db.get<{ from_sub: string | null; to_sub: string; reason: string; ts: string }>(
      'SELECT from_sub, to_sub, reason, ts FROM swaps WHERE run_id = ? ORDER BY id DESC LIMIT 1',
      r.id,
    );
    const lastSwap: Swap | null = swap ? { fromSubscriptionId: swap.from_sub, toSubscriptionId: swap.to_sub, reason: swap.reason, ts: swap.ts } : null;
    const waiting = this.pendingRespawn.get(r.id) ?? null;
    const status: RunStatus = waiting && r.status === 'running' ? 'swapping' : r.status;
    const agent = this.coord.agent(r.session_id);
    const lastActivity = agent?.last_seen ?? r.ended_at ?? r.created_at;
    return {
      id: r.id,
      name: r.name,
      cwd: r.last_cwd ?? r.cwd,
      repoId: r.repo_id,
      sessionId: r.session_id,
      subscriptionId: r.subscription_id,
      subscriptionLabel: this.subs.row(r.subscription_id)?.label ?? r.subscription_id,
      status,
      agentStatus: agent?.status ?? null,
      autoSwap: bool(r.auto_swap),
      swapCount: r.swap_count,
      lastSwap,
      args: parseArgs(r.extra_args),
      version: r.version,
      staleRunner: this.runnerStale(r.id),
      cwdMissing: !fs.existsSync(r.last_cwd ?? r.cwd),
      model: r.model,
      autoCompact: r.auto_compact === null ? getSettings(this.db).defaultAutoCompact : bool(r.auto_compact),
      autoCompactTokens: r.auto_compact_tokens ?? getSettings(this.db).defaultAutoCompactTokens,
      skipPermissions: r.skip_permissions === null ? getSettings(this.db).defaultSkipPermissions : bool(r.skip_permissions),
      continueOnResume: r.continue_on_resume === null ? getSettings(this.db).continueOnResume : bool(r.continue_on_resume),
      waiting: waiting
        ? {
            kind: waiting.kind,
            reason: waiting.reason,
            since: new Date(waiting.queuedAt).toISOString(),
            deadline: waiting.deadline === null ? null : new Date(waiting.deadline).toISOString(),
          }
        : null,
      pid: r.pid,
      cols: r.cols,
      rows: r.rows,
      createdAt: r.created_at,
      lastActivity,
      attention: attentionFor({
        agentStatus: agent?.status ?? null,
        lastActivity,
        lastViewedAt: r.last_viewed_at,
        unread: this.unreadForOperator(r.session_id),
      }),
      endedAt: r.ended_at,
      exitCode: r.exit_code,
    };
  }

  // ------------------------------------------------------------ session name

  /** The Windows Terminal window a new session's tab should join. */
  private terminalWindow(): string | undefined {
    // An explicit SWITCHBOARD_WT_WINDOW is the operator's word on it, so the setting steps aside.
    if (process.env.SWITCHBOARD_WT_WINDOW) return undefined;
    return getSettings(this.db).terminalWindow === 'switchboard' ? 'switchboard' : '0';
  }

  /** Whether the process last started for a run was picking up an existing conversation. */
  private readonly resumedSpawn = new Map<string, boolean>();

  /**
   * Runs whose resume has already been reported as failed, so one bad spawn costs one stop and one
   * toast however many hooks the wrong session goes on to fire. Cleared when the run is spawned
   * again, which is the next thing that could fail.
   */
  private readonly resumeLostReported = new Set<string>();

  /** Files Claude Code keeps for a session, once found: keyed by run id and file name. */
  private readonly sessionFiles = new Map<string, string>();
  /** Size and mtime of each transcript when it was last read, so an unchanged one is not reread. */
  private readonly transcriptSeen = new Map<string, string>();

  /**
   * Find a file Claude Code keeps for this session under its project directory: either inside the
   * session's own directory (`custom-title.json`) or, via `..`, beside it (the transcript is
   * `<session>.jsonl`, next to the `<session>/` directory).
   */
  private sessionFile(r: RunRow, name: string): string | null {
    const key = `${r.id}:${name}`;
    const cached = this.sessionFiles.get(key);
    if (cached && fs.existsSync(cached)) return cached;
    const roots = [this.subs.row(r.subscription_id)?.config_dir, HOME_CLAUDE_DIR].filter((x): x is string => !!x);
    const remember = (file: string): string => {
      this.sessionFiles.set(key, file);
      return file;
    };
    for (const root of roots) {
      for (const dir of new Set([r.last_cwd ?? r.cwd, r.cwd])) {
        const file = path.join(root, 'projects', projectSlug(dir), r.session_id, name);
        if (fs.existsSync(file)) return remember(file);
      }
    }
    // The session may have been started somewhere else entirely (a resumed GUID, a moved cwd).
    for (const root of roots) {
      let projects: string[];
      try {
        projects = fs.readdirSync(path.join(root, 'projects'));
      } catch {
        continue;
      }
      for (const slug of projects) {
        const file = path.join(root, 'projects', slug, r.session_id, name);
        if (fs.existsSync(file)) return remember(file);
      }
    }
    return null;
  }

  /**
   * Pick up what changed inside a live session without waiting for it to say so. `/rename` and
   * `/model` both write to disk at once and fire no hook, so a session renamed or switched while
   * idle would otherwise show the old value until someone typed into it.
   *
   * Names go one way only here: a rename made in Switchboard is carried into the session by a hook
   * response, and consuming that pending push would lose it. See titleDecision.
   */
  /**
   * Take the sessions whose queued respawn has waited long enough. Everything else stays queued
   * until its Stop hook says the turn is over, which is where onIdle picks it up.
   */
  drainPending(): void {
    for (const [runId, plan] of [...this.pendingRespawn]) {
      if (plan.deadline === null || Date.now() < plan.deadline) continue;
      const r = this.row(runId);
      if (!r || r.status === 'exited') {
        this.pendingRespawn.delete(runId);
        this.savePending(runId, null);
        continue;
      }
      log.info('respawning on deadline', { run: runId, kind: plan.kind, waitedMs: Date.now() - plan.queuedAt });
      try {
        this.executeRespawn(r, plan);
      } catch (err) {
        this.pendingRespawn.delete(runId);
        this.savePending(runId, null);
        this.bus.toast('error', `${r.name}: ${plan.kind} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Keep a queued respawn across a daemon restart. An update that queued behind an hour-long turn
   * would otherwise be forgotten in the gap, and the session would carry on for days on the build
   * it was told to leave.
   */
  private savePending(runId: string, plan: PendingRespawn | null): void {
    this.db.run('UPDATE runs SET pending_respawn = ? WHERE id = ?', plan ? JSON.stringify(plan) : null, runId);
  }

  private loadPending(): void {
    for (const r of this.db.all<{ id: string; pending_respawn: string | null }>(
      'SELECT id, pending_respawn FROM runs WHERE pending_respawn IS NOT NULL',
    )) {
      try {
        this.pendingRespawn.set(r.id, JSON.parse(r.pending_respawn!) as PendingRespawn);
      } catch {
        this.savePending(r.id, null);
      }
    }
    if (this.pendingRespawn.size) log.info('restored queued respawns', { count: this.pendingRespawn.size });
  }

  pollSessions(): void {
    for (const r of this.db.all<RunRow>("SELECT * FROM runs WHERE status <> 'exited'")) {
      const titleFile = this.sessionFile(r, 'custom-title.json');
      const title = titleFile ? readCustomTitle(titleFile) : null;
      // Adopting a title that already matches the name is a no-op rename that records the shadow.
      if (title && title !== r.claude_title) {
        this.db.run('UPDATE runs SET name = ?, claude_title = ? WHERE id = ?', title, title, r.id);
        this.pushTitle(this.row(r.id)!);
        this.coord.renameAgent(r.session_id, title);
        this.bus.invalidate('state');
        log.info('session renamed in claude', { run: r.id, name: title });
      }
      const transcript = this.sessionFile(r, path.join('..', `${r.session_id}.jsonl`));
      if (transcript && this.transcriptChanged(r.id, transcript)) this.syncModel(r.session_id, transcript);
      // What the tab says it wants follows the session's state, which changes under hooks rather
      // than under anything here; this poll is where the two are brought back together.
      this.pushTitle(this.row(r.id) ?? r);
    }
  }

  private transcriptChanged(runId: string, file: string): boolean {
    let stamp: string;
    try {
      const st = fs.statSync(file);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      return false;
    }
    if (this.transcriptSeen.get(runId) === stamp) return false;
    this.transcriptSeen.set(runId, stamp);
    return true;
  }

  /**
   * Switchboard and Claude Code hold one name between them; see titleDecision. Returns the title to
   * push into the session, if any.
   */
  syncTitle(sessionId: string, reported: string | null): string | null {
    const r = this.bySession(sessionId);
    if (!r) return null;
    const { adopt, push } = titleDecision(r.name, r.claude_title, reported);
    if (adopt) {
      this.db.run('UPDATE runs SET name = ?, claude_title = ? WHERE id = ?', adopt, adopt, r.id);
      this.pushTitle(this.row(r.id)!);
      this.coord.renameAgent(sessionId, adopt);
      this.bus.invalidate('state');
      log.info('session renamed in claude', { run: r.id, name: adopt });
      return null;
    }
    if (push) this.db.run('UPDATE runs SET claude_title = ? WHERE id = ?', push, r.id);
    return push ?? null;
  }

  /**
   * Follow a `/model` made inside the session. Claude Code names the model in the SessionStart
   * hook only, so the transcript is the live source; see readSessionModel.
   */
  syncModel(sessionId: string, transcriptPath: string | null): void {
    if (!transcriptPath) return;
    const r = this.bySession(sessionId);
    if (!r) return;
    const model = readSessionModel(transcriptPath);
    if (!model || model === r.model) return;
    this.db.run('UPDATE runs SET model = ? WHERE id = ?', model, r.id);
    this.bus.invalidate('state');
    log.info('session model changed in claude', { run: r.id, model });
  }

  /** Change what this session does when it comes back. Takes effect on its next resume. */
  setContinueOnResume(runId: string, on: boolean): Run {
    const r = this.row(runId);
    if (!r) throw httpError(404, 'Unknown session');
    this.db.run('UPDATE runs SET continue_on_resume = ? WHERE id = ?', on ? 1 : 0, r.id);
    this.bus.invalidate('state');
    return this.dto(this.row(runId)!);
  }

  rename(runId: string, name: string): Run {
    const r = this.row(runId);
    if (!r) throw httpError(404, 'Unknown session');
    const clean = name.trim();
    if (!clean) throw httpError(400, 'Name cannot be empty');
    if (clean.length > 120) throw httpError(400, 'Name is too long');
    this.db.run('UPDATE runs SET name = ? WHERE id = ?', clean, r.id);
    this.pushTitle(this.row(r.id)!);
    this.coord.renameAgent(r.session_id, clean);
    this.bus.invalidate('state');
    // The session hears about it on its next hook: a prompt, or the next time it starts.
    return this.dto(this.row(runId)!);
  }

  list(): Run[] {
    return this.db
      .all<RunRow>("SELECT * FROM runs ORDER BY (status = 'exited'), created_at DESC LIMIT 200")
      .map((r) => this.dto(r));
  }

  get(id: string): Run | null {
    const r = this.row(id);
    return r ? this.dto(r) : null;
  }

  // --------------------------------------------------------------- create

  private resolveSubscription(ref: string, exclude?: string | null, runId?: string, atLimit = false): string {
    if (ref === 'auto') {
      const best = this.subs.pickBest(exclude, runId, atLimit);
      if (!best) throw httpError(409, 'No enabled, logged-in subscription with headroom is available.');
      return best.id;
    }
    const sub = this.subs.row(ref);
    if (!sub) throw httpError(404, `Unknown subscription ${ref}`);
    if (sub.status !== 'ready') throw httpError(409, `${sub.label} is not logged in.`);
    return sub.id;
  }

  private async insertRun(spec: {
    cwd: string;
    subscriptionId: string;
    name?: string;
    worktree?: string;
    resumeSessionId?: string;
    autoSwap?: boolean;
    args?: string[];
    model?: string | null;
    autoCompact?: boolean;
    autoCompactTokens?: number;
    skipPermissions?: boolean;
    continueOnResume?: boolean;
  }): Promise<RunRow> {
    const cwd = path.resolve(spec.cwd);
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw httpError(400, `Directory not found: ${cwd}`);
    if (spec.resumeSessionId && this.bySession(spec.resumeSessionId)) throw httpError(409, 'That session is already running in Switchboard.');
    const extraArgs = (spec.args ?? []).filter((a) => a.trim() !== '');
    rejectReservedArgs(extraArgs);
    const settings = getSettings(this.db);
    const model = spec.model === undefined ? settings.defaultModel : spec.model;
    if (model) this.models.validate(model);
    const autoCompact = spec.autoCompact ?? settings.defaultAutoCompact;
    const autoCompactTokens = Math.min(990_000, Math.max(20_000, Math.round(spec.autoCompactTokens ?? settings.defaultAutoCompactTokens)));
    const skipPermissions = spec.skipPermissions ?? settings.defaultSkipPermissions;
    const subscriptionId = this.resolveSubscription(spec.subscriptionId);
    const id = crypto.randomBytes(4).toString('hex');
    const name = spec.name?.trim() || `${path.basename(cwd)}${spec.worktree ? `/${spec.worktree}` : ''}`;
    const repoId = await this.coord.repoForDir(cwd);
    this.db.run(
      `INSERT INTO runs (id, name, cwd, repo_id, session_id, subscription_id, status, auto_swap, worktree, resume, extra_args, model, auto_compact, auto_compact_tokens, skip_permissions, continue_on_resume, last_viewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name.slice(0, 80),
      cwd,
      repoId,
      spec.resumeSessionId ?? crypto.randomUUID(),
      subscriptionId,
      spec.autoSwap === false ? 0 : 1,
      spec.worktree?.trim() || null,
      spec.resumeSessionId ? 1 : 0,
      extraArgs.length ? JSON.stringify(extraArgs) : null,
      model,
      autoCompact ? 1 : 0,
      autoCompactTokens,
      skipPermissions ? 1 : 0,
      spec.continueOnResume === undefined ? null : spec.continueOnResume ? 1 : 0,
      now(),
      now(),
    );
    this.subs.syncProfile(subscriptionId);
    this.bus.invalidate('state');
    return this.row(id)!;
  }

  async create(req: CreateRunRequest): Promise<Run> {
    if (!findClaude()) throw httpError(500, 'claude executable not found on PATH');
    const r = await this.insertRun(req);
    this.launcher.openTerminal({ title: r.name, cwd: r.cwd, args: ['run', '--run-id', r.id], window: this.terminalWindow() });
    log.info('run created', { id: r.id, name: r.name, subscription: r.subscription_id });
    return this.dto(r);
  }

  private buildSpec(r: RunRow, subscriptionId: string, resume: boolean): SpawnSpec {
    const claude = findClaude();
    if (!claude) throw new Error('claude executable not found on PATH');
    const sub = this.subs.row(subscriptionId);
    if (!sub) throw new Error(`unknown subscription ${subscriptionId}`);
    // Claude Code exits with "No conversation found" when asked to resume a session it never wrote
    // a transcript for, which is any session that was started and then restarted before it was
    // used. Start it under the same id instead, so the session keeps its identity either way.
    const canResume = resume && !!this.sessionFile(r, path.join('..', `${r.session_id}.jsonl`));
    this.resumedSpawn.set(r.id, canResume);
    // Asking for a conversation by id is a promise the process has to keep; see rebind.
    this.db.run('UPDATE runs SET resuming = ? WHERE id = ?', canResume ? r.session_id : null, r.id);
    this.resumeLostReported.delete(r.id);
    const args: string[] = canResume ? ['--resume', r.session_id] : ['--session-id', r.session_id];
    // Before the process exists, so it never reaches the trust dialog: the folder was chosen here.
    this.subs.trustFolder(subscriptionId, r.last_cwd ?? r.cwd);
    // And so the channel this session is about to ask for resolves to something.
    this.subs.ensureMcpRegistered(subscriptionId);
    /*
     * Always, rather than only when the user's own config lacks the server.
     *
     * That test read ~/.claude.json, but a session runs against its subscription's profile, and the
     * profile only receives the registration when syncProfile can write it — which it refuses to do
     * while any session on that subscription is running, to avoid racing a live claude rewriting the
     * same file. A busy subscription therefore never got it, and every session on it was launched
     * asking for a channel on "server:switchboard" that its profile had never heard of: no sb_ tools
     * and nothing to push into. Only the default subscription worked, because there the profile is
     * ~/.claude itself.
     *
     * Passing it per launch settles the question at the point of use, and carries the run id so the
     * shim knows which session it belongs to, which the registered copy cannot.
     */
    const file = writeRuntimeJson(`mcp-${r.id}.json`, { mcpServers: { switchboard: mcpServerEntry({ SWITCHBOARD_RUN_ID: r.id }) } });
    args.push('--mcp-config', file);
    args.push('--dangerously-load-development-channels', 'server:switchboard');
    // Auto-compact is a setting, not a flag, so it rides in the per-run settings file next to the
    // hooks (which are only needed when the profile does not already carry them).
    const runSettings: Record<string, unknown> = {
      autoCompactEnabled: this.dto(r).autoCompact,
      autoCompactWindow: this.dto(r).autoCompactTokens,
    };
    if (!hooksInstalledIn(path.join(sub.config_dir, 'settings.json'))) runSettings.hooks = hooksConfig();
    args.push('--settings', writeRuntimeJson(`settings-${r.id}.json`, runSettings));
    if (r.model) args.push('--model', r.model);
    if (this.dto(r).skipPermissions) args.push('--dangerously-skip-permissions');
    if (!resume && r.worktree) args.push('--worktree', r.worktree);
    if (!resume) args.push('--name', r.name);
    // Global settings first, then this session's own arguments, so a session can override.
    args.push(...getSettings(this.db).claudeArgs, ...parseArgs(r.extra_args));
    const cmd = claudeCommand(claude, args);
    return {
      runId: r.id,
      sessionId: r.session_id,
      resume,
      cwd: resume ? (r.last_cwd ?? r.cwd) : r.cwd,
      file: cmd.file,
      args: cmd.args,
      env: { ...this.subs.envFor(subscriptionId), SWITCHBOARD_RUN_ID: r.id, SWITCHBOARD_URL: DAEMON_URL },
      title: r.name,
      subscriptionLabel: sub.label,
    };
  }

  // -------------------------------------------------------------- runners

  private send(runId: string, msg: DaemonToRunner): boolean {
    const ws = this.conns.get(runId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  private mirror(r: RunRow, cols?: number, rows?: number): TermMirror {
    let m = this.mirrors.get(r.id);
    if (!m) {
      m = new TermMirror(cols ?? r.cols, rows ?? r.rows);
      this.mirrors.set(r.id, m);
    } else if (cols && rows) {
      m.resize(cols, rows);
    }
    return m;
  }

  /** The tab title last accepted by each runner, so an unchanged one is not resent every sweep. */
  private readonly tabTitles = new Map<string, string>();

  /**
   * Put the session's name and what it wants on its terminal tab. Called on a rename and from the
   * poll, which is what carries a change of state: the status a mark reflects is set by hooks
   * arriving at the coordinator, and asking here costs one query against rows already in memory.
   */
  private pushTitle(r: RunRow): void {
    const text = tabTitle(this.dto(r), r.name);
    if (this.tabTitles.get(r.id) === text) return;
    // Only remembered once a runner has taken it; one that is not attached yet gets it next time.
    if (this.send(r.id, { type: 'title', text })) this.tabTitles.set(r.id, text);
  }

  private setStatus(id: string, status: RunStatus, extra = ''): void {
    this.db.run(`UPDATE runs SET status = ?${extra} WHERE id = ?`, status, id);
    const r = this.row(id);
    if (r) this.mirrors.get(id)?.broadcast({ type: 'status', status, subscriptionLabel: this.subs.row(r.subscription_id)?.label ?? '' });
    this.bus.invalidate('state');
  }

  attachRunner(ws: WebSocket): void {
    let runId: string | null = null;
    /*
     * Handled one after another rather than as they arrive. A hello that creates a manual run has to
     * ask git which repository it is in, and everything the runner sends next — the spawn, the first
     * screenful of output — depends on that having finished. Chaining keeps the order the socket
     * delivered them in without holding the event loop while git answers.
     */
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      let msg: RunnerToDaemon;
      try {
        msg = JSON.parse(String(raw)) as RunnerToDaemon;
      } catch {
        return;
      }
      queue = queue
        .then(async () => {
          if (msg.type === 'hello') runId = await this.onHello(ws, msg);
          else if (runId) this.onRunnerMessage(runId, msg);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error('runner message failed', message);
          ws.send(JSON.stringify({ type: 'error', message } satisfies DaemonToRunner));
        });
    });
    ws.on('close', () => {
      if (!runId || this.conns.get(runId) !== ws) return;
      this.conns.delete(runId);
      const r = this.row(runId);
      if (r && r.status !== 'exited') this.setStatus(runId, 'disconnected');
    });
  }

  private async onHello(ws: WebSocket, msg: Extract<RunnerToDaemon, { type: 'hello' }>): Promise<string> {
    let r: RunRow | undefined;
    if (msg.runId) {
      r = this.row(msg.runId);
      if (!r) throw new Error(`Unknown run ${msg.runId}`);
    } else if (msg.manual) {
      r = await this.insertRun(msg.manual satisfies ManualRunSpec);
    } else {
      throw new Error('hello without run');
    }
    const previous = this.conns.get(r.id);
    if (previous && previous !== ws) previous.close();
    this.conns.set(r.id, ws);
    // A runner that does not report its start time predates the field, which makes it stale by
    // definition — the opposite of what treating it as new would say.
    this.runnerStartedAt.set(r.id, msg.startedAt ? Date.parse(msg.startedAt) : 0);
    const mirror = this.mirror(r, msg.cols, msg.rows);
    if (msg.alive) {
      // Daemon restarted while the runner kept claude alive: just reattach and repaint.
      this.db.run('UPDATE runs SET pid = ?, cols = ?, rows = ? WHERE id = ?', msg.pid, msg.cols, msg.rows, r.id);
      this.setStatus(r.id, 'running');
      mirror.reset();
      this.send(r.id, { type: 'redraw' });
    } else {
      const spec = this.buildSpec(r, r.subscription_id, bool(r.resume));
      this.db.run('UPDATE runs SET resume = 1 WHERE id = ?', r.id);
      this.send(r.id, { type: 'spawn', spec });
      this.replayWebSize(r.id);
    }
    return r.id;
  }

  private onRunnerMessage(runId: string, msg: RunnerToDaemon): void {
    const r = this.row(runId);
    if (!r) return;
    switch (msg.type) {
      case 'spawned':
        this.armContinue(r);
        this.db.run(
          'UPDATE runs SET pid = ?, cols = ?, rows = ?, version = ?, ended_at = NULL, exit_code = NULL WHERE id = ?',
          msg.pid,
          msg.cols,
          msg.rows,
          this.versionProvider(),
          runId,
        );
        this.mirror(r, msg.cols, msg.rows);
        this.setStatus(runId, 'running');
        break;
      case 'data':
        this.mirror(r).write(msg.data);
        break;
      case 'resize':
        this.db.run('UPDATE runs SET cols = ?, rows = ? WHERE id = ?', msg.cols, msg.rows, runId);
        this.mirror(r).resize(msg.cols, msg.rows);
        break;
      case 'exit':
        if (this.relaunching.has(runId)) {
          // The terminal is closing so a fresh one can take over, resuming the same session.
          this.openTerminalFor(r);
          break;
        }
        if (msg.intentional && r.status === 'swapping') break;
        this.db.run('UPDATE runs SET ended_at = ?, exit_code = ? WHERE id = ?', now(), msg.code, runId);
        this.setStatus(runId, 'exited');
        this.coord.markOffline(r.session_id, 'session exited');
        this.pendingRespawn.delete(runId);
        break;
      case 'limit-detected':
        this.onLimit(r.session_id, msg.text, 'pty');
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------- viewers

  /**
   * Note that the operator has this session's terminal in front of them. Called when a browser
   * opens it and again when it closes, so a long read leaves the mark at the end rather than the
   * beginning and whatever arrived while it was open counts as seen.
   */
  markViewed(runId: string): void {
    this.db.run('UPDATE runs SET last_viewed_at = ? WHERE id = ?', now(), runId);
    const r = this.row(runId);
    if (r?.repo_id) this.coord.markHumanReadFrom(r.session_id);
    this.bus.invalidate('state');
  }

  /**
   * Tell a runner the size a browser is watching at. Sent after a spawn rather than waiting to be
   * asked: the browser only speaks when its own layout changes, and a session coming up under one
   * is not a layout change.
   */
  private replayWebSize(runId: string): void {
    const s = this.webSize.get(runId);
    if (s) this.send(runId, { type: 'resize', cols: s.cols, rows: s.rows });
  }

  attachViewer(runId: string, ws: WebSocket): void {
    const r = this.row(runId);
    if (!r) {
      ws.close(4404, 'unknown run');
      return;
    }
    this.markViewed(runId);
    const mirror = this.mirror(r);
    const detach = mirror.attach((frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    });
    ws.send(JSON.stringify({ type: 'status', status: this.dto(r).status, subscriptionLabel: this.subs.row(r.subscription_id)?.label ?? '' }));
    ws.on('message', (raw) => {
      let frame: TermClientFrame;
      try {
        frame = JSON.parse(String(raw)) as TermClientFrame;
      } catch {
        return;
      }
      if (frame.type === 'input' && typeof frame.data === 'string') this.send(runId, { type: 'input', data: frame.data });
      if (frame.type === 'resize' && frame.cols >= 20 && frame.rows >= 5 && frame.cols <= 500 && frame.rows <= 200) {
        const cols = Math.floor(frame.cols);
        const rows = Math.floor(frame.rows);
        this.webSize.set(runId, { cols, rows });
        this.send(runId, { type: 'resize', cols, rows });
      }
      // The browser stopped fitting: the console the session runs in owns the size again, so both
      // views end up showing the same frame rather than one of them keeping a phone's dimensions.
      if (frame.type === 'release-size') {
        this.webSize.delete(runId);
        this.send(runId, { type: 'restore-size' });
      }
    });
    ws.on('close', () => {
      detach();
      this.markViewed(runId);
      // Last browser viewer gone: give the size back to the terminal window the session lives in,
      // otherwise it stays at whatever a phone asked for until someone resizes that window.
      if (mirror.viewers === 0) {
        this.webSize.delete(runId);
        this.send(runId, { type: 'restore-size' });
      }
    });
  }

  // ----------------------------------------------------------------- swap

  swap(runId: string, targetRef: string, reason: string, opts: { force?: boolean; continueAfter?: boolean; deadline?: number | null; atLimit?: boolean } = {}): Run {
    const r = this.liveRun(runId);
    const target = this.resolveSubscription(targetRef, r.subscription_id, r.id, opts.atLimit ?? false);
    if (target === r.subscription_id) throw httpError(400, 'Session already runs on that subscription');
    return this.respawn(
      r,
      { target, reason, continueAfter: opts.continueAfter ?? false, kind: 'swap', queuedAt: Date.now(), deadline: opts.deadline ?? null },
      opts.force ?? false,
    );
  }

  /** Restart a session on the same subscription, e.g. to pick up a new claude build. */
  restart(runId: string, reason: string, force = false): Run {
    const r = this.liveRun(runId);
    // An update can always wait: no deadline, however long the turn runs.
    return this.respawn(r, { target: r.subscription_id, reason, continueAfter: false, kind: 'restart', queuedAt: Date.now(), deadline: null }, force);
  }

  /** Queue every live session for a restart; each one waits until its turn finishes. */
  restartAll(reason: string): number {
    let queued = 0;
    for (const r of this.db.all<RunRow>(`SELECT * FROM runs WHERE status IN ('running', 'starting', 'swapping')`)) {
      if (!this.conns.has(r.id)) continue;
      // A session already on its way to another subscription will come back on the new build anyway;
      // queueing a restart behind that swap would only take the turn twice.
      if (this.pendingRespawn.has(r.id)) continue;
      try {
        this.restart(r.id, reason);
        queued++;
      } catch (err) {
        log.warn('could not queue restart', { run: r.id, error: err instanceof Error ? err.message : err });
      }
    }
    return queued;
  }

  pendingRestartCount(): number {
    let n = 0;
    for (const p of this.pendingRespawn.values()) if (p.kind === 'restart') n++;
    return n;
  }

  private liveRun(runId: string): RunRow {
    const r = this.row(runId);
    if (!r) throw httpError(404, 'Unknown run');
    if (r.status === 'exited') throw httpError(409, 'Session has exited');
    if (!this.conns.has(runId)) throw httpError(409, 'The runner for this session is not connected');
    return r;
  }

  private unreadForOperator(sessionId: string): number {
    if (!this.operatorUnread || Date.now() - this.operatorUnread.at > 1000) {
      this.operatorUnread = { at: Date.now(), by: this.coord.humanUnreadBySession() };
    }
    return this.operatorUnread.by.get(sessionId) ?? 0;
  }

  private busy(r: RunRow): boolean {
    return !safeToRespawn(this.coord.agent(r.session_id)?.status);
  }

  /** Defer until the agent is idle unless forced, so a respawn never interrupts a turn. */
  private respawn(r: RunRow, plan: PendingRespawn, force: boolean): Run {
    if (!force && this.busy(r)) {
      this.pendingRespawn.set(r.id, plan);
      this.savePending(r.id, plan);
      const what = plan.kind === 'swap' ? `switch to ${this.subs.row(plan.target)?.label}` : `restart (${plan.reason})`;
      const patience = plan.deadline ? ` (at the latest in ${Math.round((plan.deadline - Date.now()) / 60_000)} min)` : '';
      this.bus.toast('info', `${r.name}: will ${what} when the current turn ends${patience}`);
      this.bus.invalidate('state');
      return this.dto(r);
    }
    this.executeRespawn(r, plan);
    return this.dto(this.row(r.id)!);
  }

  private executeRespawn(r: RunRow, plan: PendingRespawn): void {
    const { target, reason, continueAfter, kind } = plan;
    // Read before the kill, because after it the session comes back with no memory of being cut off.
    const interrupted = this.busy(r);
    this.pendingRespawn.delete(r.id);
    this.savePending(r.id, null);
    const from = r.subscription_id;
    let banner: string;
    if (kind === 'swap') {
      this.subs.syncProfile(target);
      this.subs.propagateTrust(from, target, r.last_cwd ?? r.cwd);
      this.db.run('INSERT INTO swaps (run_id, from_sub, to_sub, reason, ts) VALUES (?, ?, ?, ?, ?)', r.id, from, target, reason, now());
      this.db.run('UPDATE runs SET subscription_id = ?, swap_count = swap_count + 1, resume = 1 WHERE id = ?', target, r.id);
      this.coord.setSubscription(r.session_id, target);
      const fromLabel = this.subs.row(from)?.label ?? from;
      const toLabel = this.subs.row(target)?.label ?? target;
      banner = `\x1b[1;36m[switchboard]\x1b[0m ${fromLabel} → \x1b[1m${toLabel}\x1b[0m (${reason}). Resuming session…\r\n`;
    } else {
      this.db.run('UPDATE runs SET resume = 1 WHERE id = ?', r.id);
      banner = `\x1b[1;36m[switchboard]\x1b[0m Restarting on \x1b[1m${reason}\x1b[0m. Resuming session…\r\n`;
    }
    this.setStatus(r.id, 'swapping');
    /*
     * Half of Switchboard lives in the process hosting the terminal, and that process keeps running
     * the code it started with. Respawning claude inside it brings the session back on a new build
     * of claude and an old build of everything around it — which is how a session ends up badged
     * "old host" for the rest of its life, and why a fix to the runner never reached the sessions
     * that most needed it. Coming back is the one moment when replacing the terminal costs nothing
     * that respawning inside it does not already cost, so a stale host is replaced here, whatever
     * brought the session back: a swap, a restart, an update.
     */
    const staleHost = this.runnerStale(r.id);
    if (continueAfter) this.armRespawnContinue(r, interrupted);
    if (staleHost) {
      try {
        log.info('replacing an out-of-date terminal rather than respawning inside it', { run: r.id, kind, reason });
        this.relaunch(r.id, true);
        if (r.repo_id) this.coord.event(r.repo_id, r.session_id, kind, `${r.name}: ${kind === 'swap' ? `moved to ${this.subs.row(target)?.label ?? target}` : 'restarted'} in a new terminal (${reason})`);
        this.bus.toast('info', `${r.name}: ${kind === 'swap' ? 'moved' : 'restarted'} in a new terminal — its old one predated the current build (${reason})`);
        return;
      } catch (err) {
        // Its folder is gone, or there is nothing to relaunch: respawning in place still works.
        log.warn('could not replace the terminal; respawning in it instead', { run: r.id, error: err instanceof Error ? err.message : err });
      }
    }
    const updated = this.row(r.id)!;
    const spec = this.buildSpec(updated, target, true);
    this.mirrors.get(r.id)?.reset();
    this.send(r.id, { type: 'swap', spec, banner });
    this.replayWebSize(r.id);
    const what = kind === 'swap' ? `switched to ${spec.subscriptionLabel}` : 'restarted';
    if (r.repo_id) this.coord.event(r.repo_id, r.session_id, kind, `${r.name}: ${what} (${reason})${interrupted ? ', mid-turn' : ''}`);
    this.bus.toast(interrupted ? 'warn' : 'info', `${r.name}: ${what} (${reason})${interrupted ? ' — mid-turn, its work in flight was lost' : ''}`);
    log.info(kind, { run: r.id, session: r.session_id, from, to: target, reason });
  }

  /**
   * Queue what a session is greeted with when a respawn brings it back. A swap that cut a turn
   * short says so; everything else gets the operator's continue message. Armed here and released by
   * the SessionStart hook, because typing blindly could answer a startup dialog instead of a prompt.
   */
  private armRespawnContinue(r: RunRow, interrupted: boolean): void {
    const text = interrupted ? INTERRUPTED_MESSAGE : getSettings(this.db).continueMessage.trim();
    if (!text) return;
    const old = this.pendingContinue.get(r.id);
    if (old) clearTimeout(old.timer);
    this.pendingContinue.set(r.id, { text, timer: setTimeout(() => this.giveUpContinue(r.id), CONTINUE_FALLBACK_MS) });
  }

  /**
   * Queue the continue message for a session that has just come back up on a conversation it
   * already had — a restart, a relaunch, a swap, or resuming a session id.
   *
   * Armed from the spawn rather than from the SessionStart hook, because the hook is not something
   * to depend on here: it does not arrive for every way a session comes back, and when it does it
   * is only in time to shorten the wait. A swap that carries its own message keeps it.
   */
  private armContinue(r: RunRow): void {
    if (!this.resumedSpawn.get(r.id)) return;
    this.resumedSpawn.delete(r.id);
    if (this.pendingContinue.has(r.id)) return;
    if (!this.dto(r).continueOnResume) return;
    const text = getSettings(this.db).continueMessage.trim();
    if (!text) return;
    this.pendingContinue.set(r.id, { text, timer: setTimeout(() => this.typeContinue(r.id), CONTINUE_SPAWN_DELAY_MS) });
  }

  private typeContinue(runId: string, attempt = 0): void {
    const pending = this.pendingContinue.get(runId);
    if (!pending) return;
    clearTimeout(pending.timer);

    // Never type at a session that is asking something. The continue message ends in a carriage
    // return, and on the folder trust dialog that answers "No, exit" — which is exactly how a
    // session was killed rather than resumed.
    const screen = this.mirrors.get(runId)?.screenText() ?? '';
    if (CONFIRM_FOOTER.test(screen)) {
      if (attempt < CONTINUE_RETRIES) {
        pending.timer = setTimeout(() => this.typeContinue(runId, attempt + 1), CONTINUE_RETRY_MS);
        return;
      }
      this.pendingContinue.delete(runId);
      const name = this.row(runId)?.name ?? runId;
      log.warn('continue message not sent: the session is waiting on a dialog', { run: runId });
      this.bus.toast('warn', `${name} is waiting on a dialog, so it was left alone — answer it in the terminal.`);
      return;
    }

    this.pendingContinue.delete(runId);
    log.info('typing the continue message', { run: runId, text: pending.text });
    this.send(runId, { type: 'type', text: pending.text });
  }

  /** The resumed session never reported a prompt: leave the terminal alone and say so. */
  private giveUpContinue(runId: string): void {
    const pending = this.pendingContinue.get(runId);
    if (!pending) return;
    this.pendingContinue.delete(runId);
    const r = this.row(runId);
    this.bus.toast('warn', `${r?.name ?? runId}: resumed on the new subscription but never reached a prompt — check the terminal (it may be waiting on a dialog).`);
  }

  /**
   * Open a new terminal for a run that already exists. The runner reconnects with this run's id,
   * finds no live claude, and is told to resume the same session GUID.
   */
  /** The folder a session works in, or nothing if it has since been moved or deleted. */
  private workDir(r: RunRow): string | null {
    const dir = r.last_cwd ?? r.cwd;
    return fs.existsSync(dir) ? dir : null;
  }

  private openTerminalFor(r: RunRow): void {
    this.relaunching.delete(r.id);
    if (!this.workDir(r)) {
      // Launching anyway gives a terminal that exits on a Win32 error code and nothing else.
      this.db.run('UPDATE runs SET ended_at = ? WHERE id = ?', now(), r.id);
      this.setStatus(r.id, 'exited');
      this.bus.toast('error', `${r.name}: ${r.last_cwd ?? r.cwd} no longer exists, so it cannot be opened there.`);
      return;
    }
    this.db.run('UPDATE runs SET resume = 1 WHERE id = ?', r.id);
    this.launcher.openTerminal({ title: r.name, cwd: r.last_cwd ?? r.cwd, args: ['run', '--run-id', r.id], window: this.terminalWindow() });
  }

  /**
   * Open a terminal for this session, resuming the same session GUID.
   *
   * This is how a session comes back from anything: a restart in place reuses the process hosting
   * the terminal, which is where half of Switchboard's own code lives, so only a new terminal picks
   * up a change to it — and after the machine has been off, or after a session exited on its own,
   * there is no terminal left to reuse at all. Nothing is lost either way: the conversation is
   * addressed by GUID, and Claude Code resumes it.
   */
  relaunch(runId: string, force = false): Run {
    const r = this.row(runId);
    if (!r) throw httpError(404, 'Unknown run');
    if (!this.workDir(r)) {
      throw httpError(409, `${r.last_cwd ?? r.cwd} no longer exists. Start a session in another folder and resume ${r.session_id} there.`);
    }
    const agent = this.coord.agent(r.session_id);
    if (!force && r.status !== 'exited' && agent && agent.status === 'working') {
      throw httpError(409, 'The agent is mid-turn. Wait for it to finish, or relaunch with force.');
    }
    if (r.status === 'exited') {
      // It ended — on its own, or because the machine did. Clear that so it is a live run again.
      this.db.run("UPDATE runs SET ended_at = NULL, exit_code = NULL WHERE id = ?", r.id);
      this.setStatus(r.id, 'starting');
    }
    if (!this.send(r.id, { type: 'stop' })) {
      // Nothing attached, so there is no terminal to wait for.
      this.openTerminalFor(r);
      return this.dto(this.row(runId)!);
    }
    this.relaunching.add(r.id);
    // If the runner never reports an exit (it was already gone), open one anyway.
    setTimeout(() => {
      if (!this.relaunching.has(r.id)) return;
      const fresh = this.row(r.id);
      if (fresh) this.openTerminalFor(fresh);
    }, 8000);
    return this.dto(this.row(runId)!);
  }

  /** Give the pseudo-terminal size back to the console the session runs in. */
  handoff(runId: string): void {
    if (!this.send(runId, { type: 'restore-size' })) throw httpError(409, 'This session has no terminal attached.');
  }

  stop(runId: string): void {
    const r = this.row(runId);
    if (!r) throw httpError(404, 'Unknown run');
    if (!this.send(runId, { type: 'stop' })) {
      this.db.run('UPDATE runs SET ended_at = ? WHERE id = ?', now(), runId);
      this.setStatus(runId, 'exited');
    }
  }

  forget(runId: string): void {
    const r = this.row(runId);
    if (!r) return;
    if (this.conns.has(runId)) throw httpError(409, 'Session is still connected; stop it first');
    this.db.run('DELETE FROM runs WHERE id = ?', runId);
    this.db.run('DELETE FROM swaps WHERE run_id = ?', runId);
    this.mirrors.get(runId)?.dispose();
    this.mirrors.delete(runId);
    this.resumeLostReported.delete(runId);
    this.bus.invalidate('state');
  }

  // --------------------------------------------------------- hook signals

  /**
   * A hosted session reported its session id. Usually it is the one we already hold, sometimes it
   * is a new one the run should follow (`/clear`), and sometimes it is the sign that a resume did
   * not take — which is the one case where following it loses something. Returns false when the
   * session reporting is not the one this run asked for, so the caller drops it on the floor
   * rather than putting it on the board under this run's name.
   */
  rebind(runId: string, sessionId: string): boolean {
    const r = this.row(runId);
    if (!r) return true;
    const decision = rebindDecision(r.session_id, sessionId, r.resuming);
    if (decision === 'lost') {
      // The promise outlives the failure: whatever that session says next is still not this run's.
      if (!this.resumeLostReported.has(runId)) {
        this.resumeLostReported.add(runId);
        this.resumeLost(r, sessionId);
      }
      return false;
    }
    // The process is where it was told to be, so nothing is owed on the next id it reports.
    if (r.resuming) this.db.run('UPDATE runs SET resuming = NULL WHERE id = ?', runId);
    if (decision === 'adopt') {
      // Before the run moves on: the board has to retire the conversation this terminal used to
      // hold and carry its channel across, and it can only do that while both ids are in hand.
      this.coord.sessionReplaced(r.session_id, sessionId);
      this.db.run('UPDATE runs SET session_id = ?, resume = 1 WHERE id = ?', sessionId, runId);
      this.bus.invalidate('state');
    }
    return true;
  }

  /**
   * The process came up on a conversation nobody asked for. Stop it and leave the run pointed at
   * the conversation it was sent to resume: that id is the only way back to a transcript that is
   * still sitting on disk, and a session that carries on here would take its place — its name, its
   * terminal, its row on the board — while the work it was supposed to continue quietly stopped
   * being reachable.
   */
  private resumeLost(r: RunRow, got: string): void {
    log.error('resume did not take: claude came up on a new conversation', { run: r.id, wanted: r.session_id, got });
    this.stop(r.id);
    this.bus.toast(
      'error',
      `${r.name}: Claude Code could not resume this conversation and started a new one, so it was stopped before it took the session's place. ` +
        `Nothing is lost — relaunch to try again, or pick it up yourself with: claude --resume ${r.session_id}`,
    );
  }

  onSessionStart(sessionId: string, cwd: string | null): void {
    const r = this.bySession(sessionId);
    if (!r) return;
    if (cwd) this.db.run('UPDATE runs SET last_cwd = ? WHERE id = ?', cwd, r.id);
    if (r.status !== 'running') this.setStatus(r.id, 'running');
    // The session is at a prompt, so a queued continue message need not wait out the full delay
    // armContinue allowed for.
    const pending = this.pendingContinue.get(r.id);
    if (pending) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.typeContinue(r.id), CONTINUE_DELAY_MS);
    }
  }

  onCwd(sessionId: string, cwd: string): void {
    const r = this.bySession(sessionId);
    if (r) this.db.run('UPDATE runs SET last_cwd = ? WHERE id = ?', cwd, r.id);
  }

  onIdle(sessionId: string): void {
    const r = this.bySession(sessionId);
    if (!r) return;
    const pending = this.pendingRespawn.get(r.id);
    if (pending) {
      try {
        this.executeRespawn(r, pending);
      } catch (err) {
        this.pendingRespawn.delete(r.id);
        this.bus.toast('error', `${pending.kind} of ${r.name} failed: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }
    const sub = this.subs.get(r.subscription_id);
    if (sub) this.maybeProactive(sub, [r]);
  }

  onLimit(sessionId: string, detail: string, source: 'hook' | 'pty'): void {
    const r = this.bySession(sessionId);
    if (!r || r.status === 'exited') return;
    if (Date.now() - (this.lastLimit.get(r.id) ?? 0) < LIMIT_DEBOUNCE_MS) return;
    this.lastLimit.set(r.id, Date.now());
    this.coord.setStatus(sessionId, 'limited');
    const label = this.subs.row(r.subscription_id)?.label ?? r.subscription_id;
    log.warn('usage limit', { run: r.id, subscription: r.subscription_id, source, detail });
    void (async () => {
      const sub = await this.subs.poll(r.subscription_id, true);
      if (source === 'pty') {
        // Text detection is a fallback; make sure the subscription really is at its limit.
        const u = sub?.usage;
        const used = Math.max(u?.fiveHour?.pct ?? 0, u?.sevenDay?.pct ?? 0);
        if (u && !u.stale && used < 90) {
          this.lastLimit.delete(r.id);
          return;
        }
      }
      const settings = getSettings(this.db);
      if (!settings.autoSwap || !bool(r.auto_swap)) {
        this.bus.toast('warn', `${r.name} hit the usage limit on ${label}`);
        return;
      }
      /*
       * How hard to insist depends on what the turn is still worth.
       *
       * A rate limit reported through StopFailure has already ended the turn: there is nothing left
       * to interrupt, so the session moves at once. The same limit noticed in the terminal's output
       * says nothing about the turn — a subagent may have hit it while the parent carries on, or
       * Claude Code may be between retries — and killing that costs whatever the turn had built up.
       * So it is queued instead, with a deadline: the session cannot get far on a spent
       * subscription, but its build, test run or half-written file is given time to land.
       */
      try {
        // Already stopped, so the threshold that keeps a running session from moving for a small
        // gain does not apply: anywhere with capacity left beats a subscription with none.
        this.swap(r.id, 'auto', `usage limit on ${label}`, { ...limitSwapPlan(source), continueAfter: true, atLimit: true });
      } catch (err) {
        this.bus.toast('error', `${r.name} hit the limit on ${label} and cannot switch: ${err instanceof Error ? err.message : err}`);
      }
    })();
  }

  private onUsage(sub: Subscription): void {
    const runs = this.db.all<RunRow>("SELECT * FROM runs WHERE subscription_id = ? AND status = 'running'", sub.id);
    if (runs.length) this.maybeProactive(sub, runs);
    // Fresh usage is the only news a session waiting out a limit is waiting for.
    this.rescueLimited();
  }

  /**
   * Sessions that stopped on a usage limit, revisited every time usage is read again.
   *
   * Nothing else was watching them. A session blocked at eight o'clock waited for its own window to
   * turn over even when another subscription came back with hours to spare at five past, because
   * the only thing that moved a session was crossing the proactive threshold — which a stopped
   * session, by then, was on the wrong side of everywhere.
   *
   * A session whose own subscription has recovered is not moved, only told to carry on: moving it
   * would cost a resume for nothing.
   */
  private rescueLimited(): void {
    const settings = getSettings(this.db);
    for (const r of this.db.all<RunRow>("SELECT * FROM runs WHERE status = 'running'")) {
      if (this.coord.agent(r.session_id)?.status !== 'limited') continue;
      if (this.pendingRespawn.has(r.id)) continue;
      if (Date.now() - (this.lastRescue.get(r.id) ?? 0) < RESCUE_DEBOUNCE_MS) continue;
      const own = this.subs.get(r.subscription_id);
      // Stale numbers say nothing about now, and acting on them would only type into a session
      // that is still just as stuck.
      if (!own?.usage || own.usage.stale) continue;
      const canMove = settings.autoSwap && bool(r.auto_swap);
      const best = canMove ? this.subs.rank(r.subscription_id, r.id, true) : null;
      const decision = rescueDecision({
        ownUsedPct: this.subs.usedPct(r.subscription_id),
        bestElsewherePct: best ? this.subs.usedPct(best.row.id) : null,
        threshold: settings.swapThresholdPct,
      });
      if (decision === 'wait') continue;
      this.lastRescue.set(r.id, Date.now());
      if (decision === 'move' && best) {
        try {
          this.swap(r.id, best.row.id, `${own.label} is spent; ${best.row.label} has room`, { continueAfter: true, atLimit: true });
        } catch (err) {
          log.warn('could not move a session that was waiting out a limit', { run: r.id, error: err instanceof Error ? err.message : err });
        }
      } else {
        this.resumeAfterLimit(r, `${own.label} has room again`);
      }
    }
  }

  /**
   * Tell a session whose own subscription has come back to carry on. It is sitting at a prompt with
   * a turn that ended on a limit rather than on an answer, and nothing else will ever type into it.
   */
  private resumeAfterLimit(r: RunRow, why: string): void {
    if (!this.dto(r).continueOnResume) return;
    const text = getSettings(this.db).continueMessage.trim();
    if (!text || this.pendingContinue.has(r.id)) return;
    this.pendingContinue.set(r.id, { text, timer: setTimeout(() => this.typeContinue(r.id), CONTINUE_DELAY_MS) });
    log.info('a session waiting out a limit can carry on', { run: r.id, why });
    this.bus.toast('info', `${r.name}: ${why} — telling it to carry on.`);
  }

  private maybeProactive(sub: Subscription, runs: RunRow[]): void {
    const settings = getSettings(this.db);
    if (!settings.proactiveSwap || !sub.usage || sub.usage.stale) return;
    const used = Math.max(sub.usage.fiveHour?.pct ?? 0, sub.usage.sevenDay?.pct ?? 0);
    if (used < settings.swapThresholdPct) return;
    for (const r of runs) {
      if (!bool(r.auto_swap) || this.pendingRespawn.has(r.id)) continue;
      if (this.coord.agent(r.session_id)?.status !== 'idle') continue;
      /*
       * Crossing the threshold is a reason to look, not a reason to move. A swap costs the session
       * its place in the conversation and a resume, so somewhere merely a little better is not worth
       * one — and moving for a small margin means moving back when the two drift the other way. The
       * candidate has to be clearly better than staying, counting where this session has already
       * been so a pair of subscriptions cannot pass it between them.
       */
      const best = this.subs.rank(r.subscription_id, r.id);
      if (!best) continue;
      const staying = this.subs.scoreOf(r.subscription_id);
      if (best.score < staying * SWAP_MARGIN) continue;
      try {
        this.swap(r.id, best.row.id, `${sub.label} at ${Math.round(used)}%`);
      } catch {
        // nothing better available; stay put
      }
    }
  }

  // ------------------------------------------------------------ transcripts

  recentSessions(cwd: string): Array<{ id: string; title: string; mtime: string }> {
    const dir = path.join(HOME_CLAUDE_DIR, 'projects', projectSlug(cwd));
    let files: Array<{ file: string; mtime: number }> = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 20);
    } catch {
      return [];
    }
    return files.map(({ file, mtime }) => ({ id: file.slice(0, -6), title: this.transcriptTitle(path.join(dir, file)), mtime: new Date(mtime).toISOString() }));
  }

  private transcriptTitle(file: string): string {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      let firstPrompt: string | null = null;
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let j: Record<string, any>;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if ((j.type === 'custom-title' || j.type === 'summary') && typeof (j.customTitle ?? j.summary) === 'string') return j.customTitle ?? j.summary;
        if (!firstPrompt && j.type === 'user') {
          const c = j.message?.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p: any) => p?.type === 'text')?.text : null;
          if (typeof text === 'string' && !text.startsWith('<')) firstPrompt = text.replace(/\s+/g, ' ').slice(0, 100);
        }
      }
      return firstPrompt ?? '(no prompt)';
    } catch {
      return '(unreadable)';
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}
