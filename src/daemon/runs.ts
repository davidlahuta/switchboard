import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { DAEMON_URL, HOME_CLAUDE_DIR } from '../config.ts';
import { logger } from '../log.ts';
import type { DaemonToRunner, ManualRunSpec, RunnerToDaemon, SpawnSpec } from '../shared/protocol.ts';
import type { CreateRunRequest, Run, RunStatus, Subscription, Swap, TermClientFrame } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import { claudeCommand, findClaude, hooksConfig, mcpServerEntry, projectSlug, writeRuntimeJson } from './claude.ts';
import type { Coordinator } from './coord.ts';
import { bool, type Db, now } from './db.ts';
import { newestSourceMtime } from './source.ts';
import { readCustomTitle, readSessionModel } from './transcript.ts';
import { hooksInstalledIn, integrationStatus } from './integration.ts';
import type { Launcher } from './launcher.ts';
import { TermMirror } from './mirror.ts';
import type { ModelCatalog } from './models.ts';
import { getSettings } from './settings.ts';
import type { SubscriptionManager } from './subscriptions.ts';

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
}

/** A respawn waiting for the session to finish its turn. */
interface PendingRespawn {
  /** subscription to come back on; equal to the current one for a plain restart */
  target: string;
  reason: string;
  continueAfter: boolean;
  kind: 'swap' | 'restart';
}

const LIVE: RunStatus[] = ['starting', 'running', 'swapping', 'disconnected'];
const CONTINUE_DELAY_MS = 2500;
const CONTINUE_FALLBACK_MS = 25_000;
const LIMIT_DEBOUNCE_MS = 90_000;

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

/**
 * Which side renamed the session. `shadow` is the last title the session reported, so it differing
 * from what the session reports now means the rename happened in there (/rename, or the title
 * Claude generates from a first prompt) and Switchboard follows. Otherwise a name that has moved
 * away from the shadow is the operator's, and it goes the other way. Exported for tests.
 */
export function titleDecision(name: string, shadow: string | null, reported: string | null): { adopt?: string; push?: string } {
  const title = reported?.trim() || null;
  // Adopting a title that already matches the name is a no-op rename that records the shadow, so
  // the two stop looking out of step.
  if (title && title !== shadow) return { adopt: title };
  if (name === shadow) return {};
  return { push: name };
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
  /** Set by the daemon once the updater knows which claude version is installed. */
  versionProvider: () => string | null = () => null;
  private readonly pendingContinue = new Map<string, { text: string; timer: NodeJS.Timeout }>();
  private readonly lastLimit = new Map<string, number>();

  constructor(db: Db, bus: Bus, subs: SubscriptionManager, coord: Coordinator, launcher: Launcher, models: ModelCatalog) {
    this.db = db;
    this.bus = bus;
    this.subs = subs;
    this.coord = coord;
    this.launcher = launcher;
    this.models = models;
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
    const status: RunStatus = this.pendingRespawn.has(r.id) && r.status === 'running' ? 'swapping' : r.status;
    const agent = this.coord.agent(r.session_id);
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
      model: r.model,
      autoCompact: r.auto_compact === null ? getSettings(this.db).defaultAutoCompact : bool(r.auto_compact),
      autoCompactTokens: r.auto_compact_tokens ?? getSettings(this.db).defaultAutoCompactTokens,
      skipPermissions: r.skip_permissions === null ? getSettings(this.db).defaultSkipPermissions : bool(r.skip_permissions),
      pid: r.pid,
      cols: r.cols,
      rows: r.rows,
      createdAt: r.created_at,
      lastActivity: agent?.last_seen ?? r.ended_at ?? r.created_at,
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
  pollSessions(): void {
    for (const r of this.db.all<RunRow>("SELECT * FROM runs WHERE status <> 'exited'")) {
      const titleFile = this.sessionFile(r, 'custom-title.json');
      const title = titleFile ? readCustomTitle(titleFile) : null;
      // Adopting a title that already matches the name is a no-op rename that records the shadow.
      if (title && title !== r.claude_title) {
        this.db.run('UPDATE runs SET name = ?, claude_title = ? WHERE id = ?', title, title, r.id);
        this.send(r.id, { type: 'title', text: title });
        this.coord.renameAgent(r.session_id, title);
        this.bus.invalidate('state');
        log.info('session renamed in claude', { run: r.id, name: title });
      }
      const transcript = this.sessionFile(r, path.join('..', `${r.session_id}.jsonl`));
      if (transcript && this.transcriptChanged(r.id, transcript)) this.syncModel(r.session_id, transcript);
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
      this.send(r.id, { type: 'title', text: adopt });
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

  rename(runId: string, name: string): Run {
    const r = this.row(runId);
    if (!r) throw httpError(404, 'Unknown session');
    const clean = name.trim();
    if (!clean) throw httpError(400, 'Name cannot be empty');
    if (clean.length > 120) throw httpError(400, 'Name is too long');
    this.db.run('UPDATE runs SET name = ? WHERE id = ?', clean, r.id);
    this.send(r.id, { type: 'title', text: clean });
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

  private resolveSubscription(ref: string, exclude?: string | null): string {
    if (ref === 'auto') {
      const best = this.subs.pickBest(exclude);
      if (!best) throw httpError(409, 'No enabled, logged-in subscription with headroom is available.');
      return best.id;
    }
    const sub = this.subs.row(ref);
    if (!sub) throw httpError(404, `Unknown subscription ${ref}`);
    if (sub.status !== 'ready') throw httpError(409, `${sub.label} is not logged in.`);
    return sub.id;
  }

  private insertRun(spec: {
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
  }): RunRow {
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
    this.db.run(
      `INSERT INTO runs (id, name, cwd, repo_id, session_id, subscription_id, status, auto_swap, worktree, resume, extra_args, model, auto_compact, auto_compact_tokens, skip_permissions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      name.slice(0, 80),
      cwd,
      this.coord.repoForDir(cwd),
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
      now(),
    );
    this.subs.syncProfile(subscriptionId);
    this.bus.invalidate('state');
    return this.row(id)!;
  }

  create(req: CreateRunRequest): Run {
    if (!findClaude()) throw httpError(500, 'claude executable not found on PATH');
    const r = this.insertRun(req);
    this.launcher.openTerminal({ title: r.name, cwd: r.cwd, args: ['run', '--run-id', r.id], window: this.terminalWindow() });
    log.info('run created', { id: r.id, name: r.name, subscription: r.subscription_id });
    return this.dto(r);
  }

  private buildSpec(r: RunRow, subscriptionId: string, resume: boolean): SpawnSpec {
    const claude = findClaude();
    if (!claude) throw new Error('claude executable not found on PATH');
    const sub = this.subs.row(subscriptionId);
    if (!sub) throw new Error(`unknown subscription ${subscriptionId}`);
    const args: string[] = resume ? ['--resume', r.session_id] : ['--session-id', r.session_id];
    if (!integrationStatus().mcpInstalled) {
      const file = writeRuntimeJson(`mcp-${r.id}.json`, { mcpServers: { switchboard: mcpServerEntry({ SWITCHBOARD_RUN_ID: r.id }) } });
      args.push('--mcp-config', file);
    }
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

  private setStatus(id: string, status: RunStatus, extra = ''): void {
    this.db.run(`UPDATE runs SET status = ?${extra} WHERE id = ?`, status, id);
    const r = this.row(id);
    if (r) this.mirrors.get(id)?.broadcast({ type: 'status', status, subscriptionLabel: this.subs.row(r.subscription_id)?.label ?? '' });
    this.bus.invalidate('state');
  }

  attachRunner(ws: WebSocket): void {
    let runId: string | null = null;
    ws.on('message', (raw) => {
      let msg: RunnerToDaemon;
      try {
        msg = JSON.parse(String(raw)) as RunnerToDaemon;
      } catch {
        return;
      }
      try {
        if (msg.type === 'hello') runId = this.onHello(ws, msg);
        else if (runId) this.onRunnerMessage(runId, msg);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('runner message failed', message);
        ws.send(JSON.stringify({ type: 'error', message } satisfies DaemonToRunner));
      }
    });
    ws.on('close', () => {
      if (!runId || this.conns.get(runId) !== ws) return;
      this.conns.delete(runId);
      const r = this.row(runId);
      if (r && r.status !== 'exited') this.setStatus(runId, 'disconnected');
    });
  }

  private onHello(ws: WebSocket, msg: Extract<RunnerToDaemon, { type: 'hello' }>): string {
    let r: RunRow | undefined;
    if (msg.runId) {
      r = this.row(msg.runId);
      if (!r) throw new Error(`Unknown run ${msg.runId}`);
    } else if (msg.manual) {
      r = this.insertRun(msg.manual satisfies ManualRunSpec);
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
    }
    return r.id;
  }

  private onRunnerMessage(runId: string, msg: RunnerToDaemon): void {
    const r = this.row(runId);
    if (!r) return;
    switch (msg.type) {
      case 'spawned':
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

  attachViewer(runId: string, ws: WebSocket): void {
    const r = this.row(runId);
    if (!r) {
      ws.close(4404, 'unknown run');
      return;
    }
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
        this.send(runId, { type: 'resize', cols: Math.floor(frame.cols), rows: Math.floor(frame.rows) });
      }
      // The browser stopped fitting: the console the session runs in owns the size again, so both
      // views end up showing the same frame rather than one of them keeping a phone's dimensions.
      if (frame.type === 'release-size') this.send(runId, { type: 'restore-size' });
    });
    ws.on('close', () => {
      detach();
      // Last browser viewer gone: give the size back to the terminal window the session lives in,
      // otherwise it stays at whatever a phone asked for until someone resizes that window.
      if (mirror.viewers === 0) this.send(runId, { type: 'restore-size' });
    });
  }

  // ----------------------------------------------------------------- swap

  swap(runId: string, targetRef: string, reason: string, opts: { force?: boolean; continueAfter?: boolean } = {}): Run {
    const r = this.liveRun(runId);
    const target = this.resolveSubscription(targetRef, r.subscription_id);
    if (target === r.subscription_id) throw httpError(400, 'Session already runs on that subscription');
    return this.respawn(r, { target, reason, continueAfter: opts.continueAfter ?? false, kind: 'swap' }, opts.force ?? false);
  }

  /** Restart a session on the same subscription, e.g. to pick up a new claude build. */
  restart(runId: string, reason: string, force = false): Run {
    const r = this.liveRun(runId);
    return this.respawn(r, { target: r.subscription_id, reason, continueAfter: false, kind: 'restart' }, force);
  }

  /** Queue every live session for a restart; each one waits until its turn finishes. */
  restartAll(reason: string): number {
    let queued = 0;
    for (const r of this.db.all<RunRow>(`SELECT * FROM runs WHERE status IN ('running', 'starting', 'swapping')`)) {
      if (!this.conns.has(r.id)) continue;
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

  /** Defer until the agent is idle unless forced, so a respawn never interrupts a turn. */
  private respawn(r: RunRow, plan: PendingRespawn, force: boolean): Run {
    if (!force && this.coord.agent(r.session_id)?.status === 'working') {
      this.pendingRespawn.set(r.id, plan);
      const what = plan.kind === 'swap' ? `switch to ${this.subs.row(plan.target)?.label}` : `restart (${plan.reason})`;
      this.bus.toast('info', `${r.name}: will ${what} when the current turn ends`);
      this.bus.invalidate('state');
      return this.dto(r);
    }
    this.executeRespawn(r, plan);
    return this.dto(this.row(r.id)!);
  }

  private executeRespawn(r: RunRow, plan: PendingRespawn): void {
    const { target, reason, continueAfter, kind } = plan;
    this.pendingRespawn.delete(r.id);
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
    const updated = this.row(r.id)!;
    const spec = this.buildSpec(updated, target, true);
    this.mirrors.get(r.id)?.reset();
    this.send(r.id, { type: 'swap', spec, banner });
    if (continueAfter) {
      const text = getSettings(this.db).continueMessage.trim();
      if (text) {
        const old = this.pendingContinue.get(r.id);
        if (old) clearTimeout(old.timer);
        // Armed here, but only sent once the SessionStart hook confirms a live prompt. Typing
        // blindly could answer a dialog (folder trust, permissions) instead.
        this.pendingContinue.set(r.id, { text, timer: setTimeout(() => this.giveUpContinue(r.id), CONTINUE_FALLBACK_MS) });
      }
    }
    const what = kind === 'swap' ? `switched to ${spec.subscriptionLabel}` : 'restarted';
    if (r.repo_id) this.coord.event(r.repo_id, r.session_id, kind, `${r.name}: ${what} (${reason})`);
    this.bus.toast('info', `${r.name}: ${what} (${reason})`);
    log.info(kind, { run: r.id, session: r.session_id, from, to: target, reason });
  }

  private typeContinue(runId: string): void {
    const pending = this.pendingContinue.get(runId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingContinue.delete(runId);
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
  private openTerminalFor(r: RunRow): void {
    this.relaunching.delete(r.id);
    this.db.run('UPDATE runs SET resume = 1 WHERE id = ?', r.id);
    this.launcher.openTerminal({ title: r.name, cwd: r.last_cwd ?? r.cwd, args: ['run', '--run-id', r.id], window: this.terminalWindow() });
  }

  /**
   * Close this session's terminal and open a new one, resuming the same session GUID.
   *
   * Restarting in place reuses the process hosting the terminal, which is where half of
   * Switchboard's own code lives; only a new terminal picks up a change to it. Nothing is lost:
   * the conversation is addressed by GUID and resumed.
   */
  relaunch(runId: string, force = false): Run {
    const r = this.liveRun(runId);
    const agent = this.coord.agent(r.session_id);
    if (!force && agent && agent.status === 'working') {
      throw httpError(409, 'The agent is mid-turn. Wait for it to finish, or relaunch with force.');
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
    this.bus.invalidate('state');
  }

  // --------------------------------------------------------- hook signals

  /** A hosted session got a new session id (e.g. /clear): keep the run pointed at it. */
  rebind(runId: string, sessionId: string): void {
    const r = this.row(runId);
    if (!r || r.session_id === sessionId) return;
    this.db.run('UPDATE runs SET session_id = ?, resume = 1 WHERE id = ?', sessionId, runId);
    this.bus.invalidate('state');
  }

  onSessionStart(sessionId: string, cwd: string | null): void {
    const r = this.bySession(sessionId);
    if (!r) return;
    if (cwd) this.db.run('UPDATE runs SET last_cwd = ? WHERE id = ?', cwd, r.id);
    if (r.status !== 'running') this.setStatus(r.id, 'running');
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
      try {
        this.swap(r.id, 'auto', `usage limit on ${label}`, { force: true, continueAfter: true });
      } catch (err) {
        this.bus.toast('error', `${r.name} hit the limit on ${label} and cannot switch: ${err instanceof Error ? err.message : err}`);
      }
    })();
  }

  private onUsage(sub: Subscription): void {
    const runs = this.db.all<RunRow>("SELECT * FROM runs WHERE subscription_id = ? AND status = 'running'", sub.id);
    if (runs.length) this.maybeProactive(sub, runs);
  }

  private maybeProactive(sub: Subscription, runs: RunRow[]): void {
    const settings = getSettings(this.db);
    if (!settings.proactiveSwap || !sub.usage || sub.usage.stale) return;
    const used = Math.max(sub.usage.fiveHour?.pct ?? 0, sub.usage.sevenDay?.pct ?? 0);
    if (used < settings.swapThresholdPct) return;
    for (const r of runs) {
      if (!bool(r.auto_swap) || this.pendingRespawn.has(r.id)) continue;
      if (this.coord.agent(r.session_id)?.status !== 'idle') continue;
      try {
        this.swap(r.id, 'auto', `${sub.label} at ${Math.round(used)}%`);
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
