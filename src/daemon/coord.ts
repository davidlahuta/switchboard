import path from 'node:path';
import { forgetRepoCache, matchesPattern, patternsOverlap, relPath, repoIdFor, resolveRepo } from '../git.ts';
import { logger } from '../log.ts';
import type {
  Agent,
  AgentStatus,
  Claim,
  Conflict,
  FeedEvent,
  FileTouch,
  Message,
  MessageKind,
  Note,
  NoteKind,
  Repo,
  RepoDetail,
} from '../shared/types.ts';
import { UNREAD_CAP } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import { bool, type Db, now } from './db.ts';
import { getSettings } from './settings.ts';

const log = logger('coord');

interface RepoRow {
  id: string;
  root: string;
  name: string;
  created_at: string;
  last_activity: string | null;
}

export interface AgentRow {
  id: string;
  repo_id: string;
  name: string;
  worktree: string | null;
  branch: string | null;
  cwd: string | null;
  pid: number | null;
  status: AgentStatus;
  intent: string | null;
  subscription_id: string | null;
  run_id: string | null;
  has_channel: number;
  last_tool: string | null;
  started_at: string;
  last_seen: string;
  ended_at: string | null;
  last_piggyback_at: string | null;
  read_through_id: number;
}

interface MessageRow {
  id: number;
  repo_id: string;
  from_id: string;
  to_id: string | null;
  kind: MessageKind;
  body: string;
  urgent: number;
  reply_to: number | null;
  human_read_at: string | null;
  created_at: string;
}

interface ClaimRow {
  id: number;
  repo_id: string;
  agent_id: string;
  agent_name: string;
  pattern: string;
  exclusive: number;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
}

interface NoteRow {
  id: number;
  repo_id: string;
  agent_id: string | null;
  kind: NoteKind;
  body: string;
  pinned: number;
  created_at: string;
}

interface ConflictRow {
  id: number;
  repo_id: string;
  path: string;
  kind: 'overlap' | 'claim';
  status: 'open' | 'resolved' | 'dismissed';
  agent_a: string;
  agent_b: string;
  detail: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** Delivery channel into live sessions, implemented by the agent WebSocket hub. */
export interface PushTarget {
  push(agentId: string, content: string, meta: Record<string, string>): boolean;
  isConnected(agentId: string): boolean;
}

export interface RegisterInput {
  sessionId: string;
  cwd: string;
  pid?: number | null;
  runId?: string | null;
  subscriptionId?: string | null;
  hasChannel?: boolean;
  name?: string | null;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Kinds that justify waking an agent (spending a turn) immediately. */
const PUSH_KINDS = new Set<MessageKind>(['question', 'request', 'handoff', 'conflict']);
const SYSTEM = 'switchboard';
const HUMAN = 'human';
const WARN_TTL_MS = 10 * 60_000;
const PIGGYBACK_MIN_INTERVAL_MS = 20_000;

export function editedPath(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== 'string' || !EDIT_TOOLS.has(toolName)) return null;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const p = input.file_path ?? input.notebook_path;
  return typeof p === 'string' ? p : null;
}

export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export interface DetailLimits {
  messages: number;
  events: number;
  files: number;
}

/** Payload caps for one repo view. Kept modest: this is refetched on every change. */
export const DEFAULT_LIMITS: DetailLimits = { messages: 150, events: 150, files: 250 };
/** How many recent touch rows the file panel aggregates over. Bounds the cost on busy repos. */
const TOUCH_SCAN = 4000;
/** Retention for the high-volume tables, applied by the periodic sweep. */
const EVENT_RETENTION_DAYS = 14;
const TOUCH_RETENTION_DAYS = 14;
const MAX_EVENTS_PER_REPO = 5000;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Coordinator {
  /** Exposed for tests that need to set up awkward states directly. */
  get raw(): Db {
    return this.db;
  }

  private readonly db: Db;
  private readonly bus: Bus;
  private pushTarget: PushTarget = { push: () => false, isConnected: () => false };
  private readonly warned = new Map<string, number>();
  private readonly waiters = new Map<number, Array<(m: Message) => void>>();

  constructor(db: Db, bus: Bus) {
    this.db = db;
    this.bus = bus;
  }

  setPushTarget(target: PushTarget): void {
    this.pushTarget = target;
  }

  // ---------------------------------------------------------------- repos

  ensureRepo(root: string): RepoRow {
    const id = repoIdFor(root);
    let row = this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', id);
    if (!row) {
      const ts = now();
      this.db.run('INSERT INTO repos (id, root, name, created_at, last_activity) VALUES (?, ?, ?, ?, ?)', id, root, path.basename(root), ts, ts);
      row = this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', id)!;
      this.bus.invalidate('state');
    }
    return row;
  }

  addRepo(dir: string): Repo {
    forgetRepoCache(dir);
    const info = resolveRepo(dir);
    return this.repoDto(this.ensureRepo(info.root));
  }

  repoForDir(dir: string): string {
    return this.ensureRepo(resolveRepo(dir).root).id;
  }

  private repoTouched(repoId: string): void {
    this.db.run('UPDATE repos SET last_activity = ? WHERE id = ?', now(), repoId);
  }

  // --------------------------------------------------------------- agents

  agent(id: string): AgentRow | undefined {
    return this.db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', id);
  }

  private uniqueName(repoId: string, base: string, selfId: string): string {
    const taken = new Set(
      this.db
        .all<{ name: string }>('SELECT name FROM agents WHERE repo_id = ? AND id <> ? AND status <> ?', repoId, selfId, 'offline')
        .map((r) => r.name.toLowerCase()),
    );
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`.toLowerCase())) return `${base}-${i}`;
  }

  private defaultName(branch: string | null, worktree: string, sessionId: string): string {
    const base = (branch?.split('/').pop() || path.basename(worktree) || 'agent')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .slice(0, 24);
    return `${base}-${sessionId.replace(/[^a-z0-9]/gi, '').slice(0, 4)}`;
  }

  registerAgent(input: RegisterInput): AgentRow {
    const info = resolveRepo(input.cwd);
    const repo = this.ensureRepo(info.root);
    const existing = this.agent(input.sessionId);
    const ts = now();
    if (existing) {
      const name = input.name ? this.uniqueName(repo.id, input.name, existing.id) : existing.name;
      this.db.run(
        `UPDATE agents SET repo_id = ?, name = ?, cwd = ?, worktree = ?, branch = ?, pid = COALESCE(?, pid),
           run_id = COALESCE(?, run_id), subscription_id = COALESCE(?, subscription_id),
           has_channel = CASE WHEN ? IS NULL THEN has_channel ELSE ? END,
           status = CASE WHEN status = 'offline' THEN 'idle' ELSE status END,
           ended_at = NULL, last_seen = ?
         WHERE id = ?`,
        repo.id,
        name,
        input.cwd,
        info.worktree,
        info.branch,
        input.pid ?? null,
        input.runId ?? null,
        input.subscriptionId ?? null,
        input.hasChannel === undefined ? null : 1,
        input.hasChannel ? 1 : 0,
        ts,
        existing.id,
      );
      if (existing.status === 'offline') this.event(repo.id, existing.id, 'joined', `${name} is back`);
    } else {
      const name = this.uniqueName(repo.id, input.name || this.defaultName(info.branch, info.worktree, input.sessionId), input.sessionId);
      this.db.run(
        `INSERT INTO agents (id, repo_id, name, worktree, branch, cwd, pid, status, subscription_id, run_id, has_channel, started_at, last_seen, read_through_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?,
           (SELECT COALESCE(MAX(id), 0) FROM messages WHERE repo_id = ?))`,
        input.sessionId,
        repo.id,
        name,
        info.worktree,
        info.branch,
        input.cwd,
        input.pid ?? null,
        input.subscriptionId ?? null,
        input.runId ?? null,
        input.hasChannel ? 1 : 0,
        ts,
        ts,
        repo.id,
      );
      this.event(repo.id, input.sessionId, 'joined', `${name} joined${info.branch ? ` on ${info.branch}` : ''}`);
      log.info('agent joined', { name, repo: repo.name });
    }
    this.repoTouched(repo.id);
    this.bus.invalidate('state', `repo:${repo.id}`);
    return this.agent(input.sessionId)!;
  }

  /** Update presence from a hook. Cheap no-op when nothing changed. */
  setStatus(id: string, status: AgentStatus, lastTool?: string | null): void {
    const a = this.agent(id);
    if (!a) return;
    const tool = lastTool === undefined ? a.last_tool : lastTool;
    const changed = a.status !== status || a.last_tool !== tool;
    this.db.run('UPDATE agents SET status = ?, last_tool = ?, last_seen = ?, ended_at = NULL WHERE id = ?', status, tool, now(), id);
    if (changed) this.bus.invalidate('state', `repo:${a.repo_id}`);
  }

  setCwd(id: string, cwd: string): void {
    const a = this.agent(id);
    if (!a) return;
    const info = resolveRepo(cwd);
    const ts = now();
    const repo = this.ensureRepo(info.root);
    if (repo.id === a.repo_id) {
      this.db.run('UPDATE agents SET cwd = ?, worktree = ?, branch = ?, last_seen = ? WHERE id = ?', cwd, info.worktree, info.branch, ts, id);
      this.bus.invalidate(`repo:${a.repo_id}`);
      return;
    }
    // The session moved to a different repository: it must coordinate with that repo's agents
    // instead. Its claims and intent belonged to the old repo, so they do not travel with it.
    const name = this.uniqueName(repo.id, a.name, id);
    this.db.tx(() => {
      this.db.run('UPDATE claims SET released_at = ? WHERE agent_id = ? AND released_at IS NULL', ts, id);
      this.db.run(
        `UPDATE agents SET repo_id = ?, name = ?, cwd = ?, worktree = ?, branch = ?, intent = NULL, last_seen = ?,
           read_through_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE repo_id = ?)
         WHERE id = ?`,
        repo.id,
        name,
        cwd,
        info.worktree,
        info.branch,
        ts,
        repo.id,
        id,
      );
    });
    const old = this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', a.repo_id);
    this.event(a.repo_id, id, 'left', `${a.name} moved to ${repo.name}`);
    this.event(repo.id, id, 'joined', `${name} moved in from ${old?.name ?? 'another repo'}`);
    log.info('agent changed repo', { agent: name, from: old?.name, to: repo.name });
    this.bus.invalidate('state', `repo:${a.repo_id}`, `repo:${repo.id}`);
  }

  setSubscription(id: string, subscriptionId: string): void {
    this.db.run('UPDATE agents SET subscription_id = ? WHERE id = ?', subscriptionId, id);
  }

  markOffline(id: string, why: string): void {
    const a = this.agent(id);
    if (!a || a.status === 'offline') return;
    const ts = now();
    this.db.run("UPDATE agents SET status = 'offline', ended_at = ?, last_seen = ? WHERE id = ?", ts, ts, id);
    this.db.run('UPDATE claims SET released_at = ? WHERE agent_id = ? AND released_at IS NULL', ts, id);
    this.event(a.repo_id, id, 'left', `${a.name} left (${why})`);
    this.bus.invalidate('state', `repo:${a.repo_id}`);
  }

  /**
   * Trim the high-volume tables. Without this a long-lived busy repo grows without bound, which
   * eventually shows up as a slow repo view rather than as an obvious failure.
   */
  prune(): void {
    const eventCutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86400_000).toISOString();
    const touchCutoff = new Date(Date.now() - TOUCH_RETENTION_DAYS * 86400_000).toISOString();
    const removed =
      this.db.run('DELETE FROM events WHERE ts < ?', eventCutoff).changes +
      this.db.run('DELETE FROM file_touches WHERE ts < ?', touchCutoff).changes;
    let capped = 0;
    for (const r of this.db.all<{ id: string }>('SELECT id FROM repos')) {
      capped += this.db.run(
        `DELETE FROM events WHERE repo_id = ? AND id NOT IN
           (SELECT id FROM events WHERE repo_id = ? ORDER BY id DESC LIMIT ?)`,
        r.id,
        r.id,
        MAX_EVENTS_PER_REPO,
      ).changes;
    }
    // Deliveries outlive their message only if a message is ever deleted; messages are kept.
    if (removed + capped > 0) log.info('pruned history', { aged: removed, overCap: capped });
  }

  /** Periodic liveness sweep: dead pids and long-silent hook-only agents go offline. */
  sweep(): void {
    const live = this.db.all<AgentRow>("SELECT * FROM agents WHERE status <> 'offline'");
    for (const a of live) {
      if (this.pushTarget.isConnected(a.id)) continue;
      let dead = false;
      if (a.pid) {
        try {
          process.kill(a.pid, 0);
        } catch {
          dead = true;
        }
      }
      const silentMs = Date.now() - Date.parse(a.last_seen);
      if (dead || silentMs > 3 * 3600_000 || (!a.pid && silentMs > 30 * 60_000 && a.status === 'starting')) {
        this.markOffline(a.id, dead ? 'process exited' : 'no activity');
      }
    }
  }

  /**
   * Resolve an agent reference. The session id (a GUID) is the identity; a display name is only
   * an alias, and names can be reused once their session goes offline. A name that matches more
   * than one live agent is therefore refused rather than guessed, and the caller is told to use
   * the GUID.
   */
  findAgent(repoId: string, ref: string): AgentRow | undefined {
    const r = ref.trim().replace(/^@/, '');
    if (!r) return undefined;
    const byId = this.db.get<AgentRow>('SELECT * FROM agents WHERE repo_id = ? AND id = ?', repoId, r);
    if (byId) return byId;
    const named = this.db.all<AgentRow>(
      "SELECT * FROM agents WHERE repo_id = ? AND lower(name) = lower(?) ORDER BY (status = 'offline'), last_seen DESC",
      repoId,
      r,
    );
    const live = named.filter((a) => a.status !== 'offline');
    if (live.length > 1) {
      throw new Error(`"${r}" matches ${live.length} live agents (${live.map((a) => a.id).join(', ')}). Address one by its session id.`);
    }
    if (named.length) return live[0] ?? named[0];
    // Last resort: an unambiguous session-id prefix.
    const prefix = r.length >= 8 ? this.db.all<AgentRow>('SELECT * FROM agents WHERE repo_id = ? AND id LIKE ?', repoId, `${r}%`) : [];
    return prefix.length === 1 ? prefix[0] : undefined;
  }

  private liveAgents(repoId: string): AgentRow[] {
    return this.db.all<AgentRow>("SELECT * FROM agents WHERE repo_id = ? AND status <> 'offline' ORDER BY started_at", repoId);
  }

  /**
   * Every agent name in a repo, resolved once. `nameOf` costs a query per call, which turns a
   * few hundred messages, events and file rows into a thousand queries per request.
   */
  private namesIn(repoId: string): (id: string | null) => string {
    const names = new Map<string, string>();
    for (const a of this.db.all<{ id: string; name: string }>('SELECT id, name FROM agents WHERE repo_id = ?', repoId)) names.set(a.id, a.name);
    return (id) => {
      if (!id) return 'all';
      if (id === HUMAN) return 'human';
      if (id === SYSTEM) return 'switchboard';
      return names.get(id) ?? id.slice(0, 8);
    };
  }

  private nameOf(id: string | null): string {
    if (!id) return 'all';
    if (id === HUMAN) return 'human';
    if (id === SYSTEM) return 'switchboard';
    return this.agent(id)?.name ?? id.slice(0, 8);
  }

  // --------------------------------------------------------------- events

  event(repoId: string, agentId: string | null, type: string, summary: string): void {
    this.db.run('INSERT INTO events (repo_id, agent_id, type, summary, ts) VALUES (?, ?, ?, ?, ?)', repoId, agentId, type, clip(summary, 400), now());
    this.bus.invalidate(`repo:${repoId}`);
  }

  // ----------------------------------------------------- intents & claims

  private activeClaims(repoId: string): ClaimRow[] {
    return this.db.all<ClaimRow>(
      `SELECT c.*, a.name AS agent_name FROM claims c JOIN agents a ON a.id = c.agent_id
       WHERE c.repo_id = ? AND c.released_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?) AND a.status <> 'offline'
       ORDER BY c.id`,
      repoId,
      now(),
    );
  }

  private recentTouches(repoId: string, sinceIso: string): Array<{ path: string; agent_id: string; ts: string }> {
    return this.db.all('SELECT path, agent_id, MAX(ts) AS ts FROM file_touches WHERE repo_id = ? AND ts >= ? GROUP BY path, agent_id', repoId, sinceIso);
  }

  private windowStart(): string {
    return new Date(Date.now() - getSettings(this.db).conflictWindowMin * 60_000).toISOString();
  }

  private overlapReport(a: AgentRow, patterns: string[]): string[] {
    const lines: string[] = [];
    const claims = this.activeClaims(a.repo_id).filter((c) => c.agent_id !== a.id);
    const touches = this.recentTouches(a.repo_id, this.windowStart()).filter((t) => t.agent_id !== a.id);
    for (const p of patterns) {
      for (const c of claims) {
        if (patternsOverlap(p, c.pattern)) lines.push(`${p} overlaps ${c.agent_name}'s ${c.exclusive ? 'EXCLUSIVE ' : ''}claim "${c.pattern}"`);
      }
      const hit = new Map<string, string[]>();
      for (const t of touches) {
        if (matchesPattern(t.path, p)) {
          const list = hit.get(t.agent_id) ?? [];
          list.push(t.path);
          hit.set(t.agent_id, list);
        }
      }
      for (const [agentId, files] of hit) {
        lines.push(`${p}: ${this.nameOf(agentId)} recently edited ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5})` : ''}`);
      }
    }
    return [...new Set(lines)];
  }

  /**
   * Follow a session rename. The agent's name is what peers address in messages and claims, so it
   * tracks the session name rather than drifting from it.
   */
  renameAgent(agentId: string, name: string): void {
    const a = this.agent(agentId);
    if (!a) return;
    const next = this.uniqueName(a.repo_id, name.trim().replace(/\s+/g, '-').slice(0, 40), a.id);
    if (next === a.name) return;
    this.db.run('UPDATE agents SET name = ? WHERE id = ?', next, agentId);
    this.event(a.repo_id, agentId, 'renamed', `${a.name} is now ${next}`);
    this.bus.invalidate('state', `repo:${a.repo_id}`);
  }

  setIntent(agentId: string, summary: string, files: string[] = [], name?: string): string {
    const a = this.agent(agentId);
    if (!a) throw new Error('unknown session');
    const ts = now();
    const newName = name?.trim() ? this.uniqueName(a.repo_id, name.trim().replace(/\s+/g, '-').slice(0, 32), a.id) : a.name;
    this.db.tx(() => {
      this.db.run('UPDATE agents SET intent = ?, name = ?, last_seen = ? WHERE id = ?', clip(summary, 300), newName, ts, agentId);
      this.db.run("UPDATE claims SET released_at = ? WHERE agent_id = ? AND source = 'intent' AND released_at IS NULL", ts, agentId);
      const expires = new Date(Date.now() + 4 * 3600_000).toISOString();
      for (const f of files.slice(0, 50)) {
        this.db.run(
          "INSERT INTO claims (repo_id, agent_id, pattern, exclusive, reason, source, created_at, expires_at) VALUES (?, ?, ?, 0, ?, 'intent', ?, ?)",
          a.repo_id,
          agentId,
          f,
          clip(summary, 120),
          ts,
          expires,
        );
      }
    });
    this.event(a.repo_id, agentId, 'intent', `${newName}: ${summary}`);
    const overlaps = this.overlapReport({ ...a, name: newName }, files);
    return [
      `Intent set. You are "${newName}".`,
      overlaps.length ? `Heads-up, possible overlap:\n- ${overlaps.join('\n- ')}\nConsider sb_send to coordinate.` : 'No overlaps with other agents.',
    ].join('\n');
  }

  claim(agentId: string, patterns: string[], exclusive: boolean, reason: string | null, ttlMin = 60): string {
    const a = this.agent(agentId);
    if (!a) throw new Error('unknown session');
    const others = this.activeClaims(a.repo_id).filter((c) => c.agent_id !== agentId);
    const granted: string[] = [];
    const refused: string[] = [];
    const ts = now();
    const expires = new Date(Date.now() + Math.min(1440, Math.max(1, ttlMin)) * 60_000).toISOString();
    for (const p of patterns.slice(0, 50)) {
      const blocker = others.find((c) => (c.exclusive || exclusive) && bool(c.exclusive) && patternsOverlap(p, c.pattern));
      if (exclusive && blocker) {
        refused.push(`${p} (exclusively held by ${blocker.agent_name}: "${blocker.pattern}")`);
        continue;
      }
      this.db.run(
        "INSERT INTO claims (repo_id, agent_id, pattern, exclusive, reason, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'claim', ?, ?)",
        a.repo_id,
        agentId,
        p,
        exclusive ? 1 : 0,
        reason,
        ts,
        expires,
      );
      granted.push(p);
    }
    if (granted.length) {
      this.event(a.repo_id, agentId, 'claim', `${a.name} claimed ${exclusive ? 'exclusively ' : ''}${granted.join(', ')}${reason ? ` — ${reason}` : ''}`);
      if (exclusive) {
        // Tell agents who recently edited these files, lazily.
        const touches = this.recentTouches(a.repo_id, this.windowStart()).filter((t) => t.agent_id !== agentId);
        const affected = new Set(touches.filter((t) => granted.some((g) => matchesPattern(t.path, g))).map((t) => t.agent_id));
        for (const other of affected) {
          this.send(SYSTEM, a.repo_id, other, 'warning', `${a.name} claimed ${granted.join(', ')} exclusively${reason ? ` (${reason})` : ''}. Your edits there will be blocked until they release it.`);
        }
      }
    }
    const overlaps = this.overlapReport(a, granted).filter((l) => !exclusive || !l.includes('EXCLUSIVE'));
    return [
      granted.length ? `Claimed ${granted.join(', ')} until ${expires.slice(11, 16)} UTC.` : 'Nothing claimed.',
      refused.length ? `Refused: ${refused.join('; ')}.` : '',
      overlaps.length ? `Overlaps:\n- ${overlaps.join('\n- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  release(agentId: string, patterns?: string[]): string {
    const a = this.agent(agentId);
    if (!a) throw new Error('unknown session');
    const ts = now();
    let changes = 0;
    if (patterns?.length) {
      for (const p of patterns) changes += this.db.run('UPDATE claims SET released_at = ? WHERE agent_id = ? AND pattern = ? AND released_at IS NULL', ts, agentId, p).changes;
    } else {
      changes = this.db.run('UPDATE claims SET released_at = ? WHERE agent_id = ? AND released_at IS NULL', ts, agentId).changes;
    }
    if (changes) this.event(a.repo_id, agentId, 'release', `${a.name} released ${patterns?.length ? patterns.join(', ') : 'all claims'}`);
    return `Released ${changes} claim(s).`;
  }

  releaseClaim(id: number): void {
    const c = this.db.get<{ repo_id: string; agent_id: string; pattern: string }>('SELECT repo_id, agent_id, pattern FROM claims WHERE id = ?', id);
    if (!c) return;
    this.db.run('UPDATE claims SET released_at = ? WHERE id = ?', now(), id);
    this.event(c.repo_id, null, 'release', `Operator released ${this.nameOf(c.agent_id)}'s claim "${c.pattern}"`);
    this.send(HUMAN, c.repo_id, c.agent_id, 'info', `The operator released your claim "${c.pattern}".`);
  }

  // ------------------------------------------------------------ conflicts

  private shouldWarn(key: string): boolean {
    const last = this.warned.get(key);
    if (last && Date.now() - last < WARN_TTL_MS) return false;
    this.warned.set(key, Date.now());
    if (this.warned.size > 5000) {
      for (const [k, t] of this.warned) if (Date.now() - t > WARN_TTL_MS) this.warned.delete(k);
    }
    return true;
  }

  private openConflict(repoId: string, rel: string, kind: 'overlap' | 'claim', a: string, b: string, detail: string): boolean {
    const existing = this.db.get<{ id: number }>(
      "SELECT id FROM conflicts WHERE repo_id = ? AND path = ? AND status = 'open' AND ((agent_a = ? AND agent_b = ?) OR (agent_a = ? AND agent_b = ?))",
      repoId,
      rel,
      a,
      b,
      b,
      a,
    );
    if (existing) return false;
    this.db.run(
      "INSERT INTO conflicts (repo_id, path, kind, status, agent_a, agent_b, detail, created_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?)",
      repoId,
      rel,
      kind,
      a,
      b,
      detail,
      now(),
    );
    this.event(repoId, a, 'conflict', `${kind === 'claim' ? 'Claim violation' : 'Overlap'} on ${rel}: ${this.nameOf(a)} ↔ ${this.nameOf(b)}`);
    this.bus.invalidate('state');
    return true;
  }

  resolveConflict(id: number, status: 'resolved' | 'dismissed'): void {
    const c = this.db.get<ConflictRow>('SELECT * FROM conflicts WHERE id = ?', id);
    if (!c) return;
    this.db.run('UPDATE conflicts SET status = ?, resolved_at = ? WHERE id = ?', status, now(), id);
    this.bus.invalidate('state', `repo:${c.repo_id}`);
  }

  private relFor(a: AgentRow, absPath: string): string | null {
    const abs = path.resolve(a.cwd ?? '.', absPath);
    if (a.worktree) {
      const rel = relPath(a.worktree, abs);
      if (rel) return rel;
    }
    const info = resolveRepo(path.dirname(abs));
    if (repoIdFor(info.root) !== a.repo_id) return null;
    return relPath(info.worktree, abs);
  }

  /** PreToolUse on edit tools: exclusive claims by others block; soft claims warn. */
  preEdit(agentId: string, absPath: string): { deny?: string; context?: string } {
    const a = this.agent(agentId);
    if (!a) return {};
    const rel = this.relFor(a, absPath);
    if (!rel) return {};
    const hits = this.activeClaims(a.repo_id).filter((c) => c.agent_id !== agentId && matchesPattern(rel, c.pattern));
    const hard = hits.find((c) => bool(c.exclusive));
    if (hard) {
      if (this.shouldWarn(`deny|${agentId}|${rel}`)) {
        this.openConflict(a.repo_id, rel, 'claim', agentId, hard.agent_id, `blocked edit inside exclusive claim "${hard.pattern}"`);
        this.send(SYSTEM, a.repo_id, hard.agent_id, 'info', `${a.name} tried to edit ${rel}, which you hold exclusively ("${hard.pattern}"). Release it with sb_release when you can.`);
      }
      return {
        deny: `Switchboard: ${rel} is exclusively claimed by agent "${hard.agent_name}"${hard.reason ? ` (${hard.reason})` : ''}${hard.expires_at ? ` until ${hard.expires_at.slice(11, 16)} UTC` : ''}. Do not edit it now: ask them with sb_send (to: "${hard.agent_name}", kind: "request") or continue with other work. The operator can release the claim in the Switchboard UI.`,
      };
    }
    const soft = hits[0];
    if (soft && this.shouldWarn(`soft|${agentId}|${rel}|${soft.agent_id}`)) {
      return { context: `Switchboard: ${rel} is inside ${soft.agent_name}'s claim "${soft.pattern}"${soft.reason ? ` (${soft.reason})` : ''}. Coordinate with them before larger changes.` };
    }
    return {};
  }

  /** PostToolUse on edit tools: record the touch, detect overlaps, warn both sides once. */
  recordEdit(agentId: string, absPath: string, tool: string): string | null {
    const a = this.agent(agentId);
    if (!a) return null;
    const rel = this.relFor(a, absPath);
    if (!rel) return null;
    const ts = now();
    const since = this.windowStart();
    const firstTouch = !this.db.get('SELECT 1 FROM file_touches WHERE repo_id = ? AND agent_id = ? AND path = ? AND ts >= ?', a.repo_id, agentId, rel, since);
    this.db.run('INSERT INTO file_touches (repo_id, agent_id, path, worktree, tool, ts) VALUES (?, ?, ?, ?, ?, ?)', a.repo_id, agentId, rel, a.worktree, tool, ts);
    this.repoTouched(a.repo_id);
    if (firstTouch) this.event(a.repo_id, agentId, 'edit', `${a.name} edited ${rel}`);
    else this.bus.invalidate(`repo:${a.repo_id}`);

    const warnings: string[] = [];
    const others = this.db.all<{ agent_id: string; ts: string }>(
      'SELECT agent_id, MAX(ts) AS ts FROM file_touches WHERE repo_id = ? AND path = ? AND agent_id <> ? AND ts >= ? GROUP BY agent_id',
      a.repo_id,
      rel,
      agentId,
      since,
    );
    for (const o of others) {
      const other = this.agent(o.agent_id);
      if (!other) continue;
      const opened = this.openConflict(a.repo_id, rel, 'overlap', agentId, other.id, `both edited within ${getSettings(this.db).conflictWindowMin} min`);
      if (this.shouldWarn(`overlap|${agentId}|${rel}|${other.id}`)) {
        warnings.push(
          `${other.name} (${other.branch ?? 'no branch'}${other.worktree && other.worktree !== a.worktree ? ', other worktree' : ', SAME worktree'}, ${other.status}) also edited it ${ago(o.ts)}${other.intent ? ` — their intent: "${other.intent}"` : ''}`,
        );
      }
      if (opened && other.status !== 'offline') {
        this.send(
          SYSTEM,
          a.repo_id,
          other.id,
          'conflict',
          `${a.name} just edited ${rel}, which you also changed ${ago(o.ts)}.${a.intent ? ` Their intent: "${a.intent}".` : ''} If your changes may clash, coordinate with sb_send (to: "${a.name}").`,
        );
      }
    }
    for (const c of this.activeClaims(a.repo_id)) {
      if (c.agent_id === agentId || !matchesPattern(rel, c.pattern)) continue;
      this.openConflict(a.repo_id, rel, 'claim', agentId, c.agent_id, `edit inside claim "${c.pattern}"`);
      if (this.shouldWarn(`claim|${agentId}|${rel}|${c.agent_id}`)) {
        warnings.push(`it is inside ${c.agent_name}'s ${bool(c.exclusive) ? 'EXCLUSIVE ' : ''}claim "${c.pattern}"${c.reason ? ` (${c.reason})` : ''}`);
      }
    }
    if (!warnings.length) return null;
    return `⚠ Switchboard: ${rel} — ${warnings.join('; ')}. Coordinate with sb_send before changing it further.`;
  }

  whoTouches(agentId: string, patterns: string[]): string {
    const a = this.agent(agentId);
    if (!a) throw new Error('unknown session');
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const touches = this.recentTouches(a.repo_id, since).filter((t) => t.agent_id !== agentId);
    const claims = this.activeClaims(a.repo_id).filter((c) => c.agent_id !== agentId);
    const lines: string[] = [];
    for (const p of patterns) {
      const byAgent = new Map<string, Array<{ path: string; ts: string }>>();
      for (const t of touches) {
        if (!matchesPattern(t.path, p)) continue;
        const l = byAgent.get(t.agent_id) ?? [];
        l.push(t);
        byAgent.set(t.agent_id, l);
      }
      const cl = claims.filter((c) => patternsOverlap(p, c.pattern));
      if (!byAgent.size && !cl.length) {
        lines.push(`${p}: nobody else`);
        continue;
      }
      for (const [id, list] of byAgent) {
        const ag = this.agent(id);
        list.sort((x, y) => y.ts.localeCompare(x.ts));
        lines.push(
          `${p}: ${ag?.name ?? id} [${ag?.status ?? '?'}] edited ${list.slice(0, 5).map((t) => `${t.path} (${ago(t.ts)})`).join(', ')}${list.length > 5 ? ` +${list.length - 5}` : ''}`,
        );
      }
      for (const c of cl) lines.push(`${p}: claimed by ${c.agent_name}${bool(c.exclusive) ? ' (EXCLUSIVE)' : ''} as "${c.pattern}"${c.reason ? ` — ${c.reason}` : ''}`);
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------- messages

  send(fromId: string, repoId: string, toRef: string | null, kind: MessageKind, body: string, urgent = false, replyTo: number | null = null): Message {
    let toId: string | null = null;
    const ref = toRef?.trim() ?? '';
    if (ref && !['all', '*', 'everyone', 'broadcast'].includes(ref.toLowerCase())) {
      if (ref.toLowerCase() === HUMAN || ref.toLowerCase() === 'operator' || ref.toLowerCase() === 'user') toId = HUMAN;
      else {
        const target = this.findAgent(repoId, ref);
        if (!target) {
          const known = this.liveAgents(repoId).map((x) => x.name);
          throw new Error(`Unknown agent "${ref}". Online: ${known.length ? known.join(', ') : 'none'}. Use 'all' to broadcast or 'human' for the operator.`);
        }
        toId = target.id;
      }
    }
    const ts = now();
    const { lastInsertRowid: id } = this.db.run(
      'INSERT INTO messages (repo_id, from_id, to_id, kind, body, urgent, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      repoId,
      fromId,
      toId,
      kind,
      clip(body, 8000),
      urgent ? 1 : 0,
      replyTo,
      ts,
    );
    const row = this.db.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)!;
    const fromName = this.nameOf(fromId);
    if (kind !== 'conflict') this.event(repoId, fromId === HUMAN || fromId === SYSTEM ? null : fromId, 'message', `${fromName} → ${this.nameOf(toId)}: ${clip(body, 120)}`);
    this.repoTouched(repoId);

    // Immediate push for anything that deserves a turn; everything else waits for a hook.
    const recipients = toId === null ? this.liveAgents(repoId).filter((x) => x.id !== fromId).map((x) => x.id) : toId === HUMAN ? [] : [toId];
    const pushWorthy = fromId === HUMAN || urgent || PUSH_KINDS.has(kind) || (toId !== null && kind === 'warning');
    if (pushWorthy) for (const r of recipients) this.pushMessage(r, row);

    if (replyTo) {
      const waiting = this.waiters.get(replyTo);
      if (waiting) {
        this.waiters.delete(replyTo);
        const dto = this.messageDto(row);
        for (const w of waiting) w(dto);
      }
    }
    if (toId === HUMAN) this.bus.toast('info', `${fromName} → you: ${clip(body, 140)}`);
    this.bus.invalidate('state', `repo:${repoId}`);
    return this.messageDto(row);
  }

  private formatForChannel(m: MessageRow): { content: string; meta: Record<string, string> } {
    const meta: Record<string, string> = { from: this.nameOf(m.from_id), kind: m.kind, message_id: String(m.id), to: m.to_id ? 'you' : 'all' };
    if (m.reply_to) meta.reply_to = String(m.reply_to);
    return { content: m.body, meta };
  }

  private pushMessage(agentId: string, m: MessageRow): boolean {
    if (this.db.get('SELECT 1 FROM deliveries WHERE message_id = ? AND agent_id = ?', m.id, agentId)) return true;
    const { content, meta } = this.formatForChannel(m);
    if (!this.pushTarget.push(agentId, content, meta)) return false;
    this.markDelivered([m.id], agentId, 'channel');
    return true;
  }

  private markDelivered(ids: number[], agentId: string, via: string): void {
    const ts = now();
    for (const id of ids) this.db.run('INSERT OR IGNORE INTO deliveries (message_id, agent_id, via, delivered_at) VALUES (?, ?, ?, ?)', id, agentId, via, ts);
  }

  private pending(a: AgentRow): MessageRow[] {
    const rows = this.db.all<MessageRow>(
      `SELECT m.* FROM messages m
       WHERE m.repo_id = ? AND m.id > ? AND m.from_id <> ? AND (m.to_id = ? OR m.to_id IS NULL) AND m.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = ?)
       ORDER BY m.id`,
      a.repo_id,
      a.read_through_id,
      a.id,
      a.id,
      a.started_at,
      a.id,
    );
    this.advanceWatermark(a, rows.length ? rows[0].id : null);
    return rows;
  }

  /**
   * Move an agent's watermark up to just below its oldest still-unread message, or to the newest
   * message in the repo when it has none. Everything below is settled for good — a delivery is
   * never taken back — so the next scan starts there instead of at the beginning of history.
   */
  private advanceWatermark(a: AgentRow, oldestUnread: number | null): void {
    const to =
      oldestUnread !== null
        ? oldestUnread - 1
        : (this.db.get<{ n: number | null }>('SELECT MAX(id) AS n FROM messages WHERE repo_id = ?', a.repo_id)?.n ?? 0);
    if (to <= a.read_through_id) return;
    a.read_through_id = to;
    this.db.run('UPDATE agents SET read_through_id = ? WHERE id = ? AND read_through_id < ?', to, a.id, to);
  }

  private isPushWorthy(m: MessageRow, a: AgentRow): boolean {
    return m.from_id === HUMAN || bool(m.urgent) || PUSH_KINDS.has(m.kind) || (m.to_id === a.id && m.kind === 'warning');
  }

  /** Deliver queued push-worthy messages when a channel-capable shim (re)connects. */
  flushPushQueue(agentId: string): void {
    const a = this.agent(agentId);
    if (!a) return;
    for (const m of this.pending(a)) if (this.isPushWorthy(m, a)) this.pushMessage(agentId, m);
  }

  private formatUpdates(rows: MessageRow[], more: number): string {
    const lines = rows.map((m) => {
      const hint = m.kind === 'question' || m.kind === 'request' || m.kind === 'handoff' ? ` (answer: sb_send reply_to=${m.id})` : '';
      return `- #${m.id} ${this.nameOf(m.from_id)} → ${m.to_id ? 'you' : 'all'} [${m.kind}${bool(m.urgent) ? ', urgent' : ''}]: ${clip(m.body, 700)}${hint}`;
    });
    if (more > 0) lines.push(`- …and ${more} more (sb_inbox)`);
    return `Switchboard updates from this repo:\n${lines.join('\n')}`;
  }

  /** Messages to attach to a hook response. Rate-limited unless something needs attention. */
  piggyback(agentId: string): string | null {
    const a = this.agent(agentId);
    if (!a) return null;
    const rows = this.pending(a);
    if (!rows.length) return null;
    const important = rows.some((m) => this.isPushWorthy(m, a) || m.to_id === a.id);
    if (!important && a.last_piggyback_at && Date.now() - Date.parse(a.last_piggyback_at) < PIGGYBACK_MIN_INTERVAL_MS) return null;
    const shown = rows.slice(0, 8);
    this.markDelivered(
      shown.map((m) => m.id),
      agentId,
      'hook',
    );
    this.db.run('UPDATE agents SET last_piggyback_at = ? WHERE id = ?', now(), agentId);
    this.bus.invalidate(`repo:${a.repo_id}`);
    return this.formatUpdates(shown, rows.length - shown.length);
  }

  /**
   * Stop hook for sessions without a channel: if someone is waiting on this agent, keep it going
   * instead of letting it idle. Returns the reason to show the model, or null to allow the stop.
   */
  stopBlockReason(agentId: string): string | null {
    const a = this.agent(agentId);
    if (!a || bool(a.has_channel)) return null;
    const rows = this.pending(a).filter((m) => this.isPushWorthy(m, a));
    if (!rows.length) return null;
    this.markDelivered(
      rows.map((m) => m.id),
      agentId,
      'hook',
    );
    return `${this.formatUpdates(rows.slice(0, 8), rows.length - 8)}\nHandle these before stopping (reply with sb_send), then finish.`;
  }

  inbox(agentId: string, includeSeen = false, limit = 30): string {
    const a = this.agent(agentId);
    if (!a) throw new Error('unknown session');
    let rows: MessageRow[];
    if (includeSeen) {
      rows = this.db
        .all<MessageRow>(
          'SELECT * FROM messages WHERE repo_id = ? AND (to_id = ? OR to_id IS NULL OR from_id = ?) ORDER BY id DESC LIMIT ?',
          a.repo_id,
          a.id,
          a.id,
          limit,
        )
        .reverse();
    } else {
      rows = this.pending(a).slice(0, limit);
    }
    this.markDelivered(
      rows.filter((m) => m.from_id !== a.id).map((m) => m.id),
      agentId,
      'tool',
    );
    this.bus.invalidate(`repo:${a.repo_id}`);
    if (!rows.length) return 'No new messages.';
    return rows
      .map((m) => `#${m.id} ${ago(m.created_at)} ${this.nameOf(m.from_id)} → ${m.to_id ? this.nameOf(m.to_id) : 'all'} [${m.kind}]${m.reply_to ? ` re #${m.reply_to}` : ''}: ${m.body}`)
      .join('\n');
  }

  waitForReply(messageId: number, timeoutMs: number): Promise<Message | null> {
    return new Promise((resolve) => {
      const list = this.waiters.get(messageId) ?? [];
      let done = false;
      const finish = (m: Message | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(m);
      };
      const timer = setTimeout(() => {
        const l = this.waiters.get(messageId);
        if (l) this.waiters.set(messageId, l.filter((f) => f !== finish));
        finish(null);
      }, timeoutMs);
      list.push(finish);
      this.waiters.set(messageId, list);
    });
  }

  markHumanRead(repoId: string): void {
    this.db.run("UPDATE messages SET human_read_at = ? WHERE repo_id = ? AND to_id = 'human' AND human_read_at IS NULL", now(), repoId);
    this.bus.invalidate('state', `repo:${repoId}`);
  }

  // ---------------------------------------------------------------- notes

  note(agentId: string | null, repoId: string, kind: NoteKind, body: string, pinned: boolean): Note {
    const { lastInsertRowid: id } = this.db.run(
      'INSERT INTO notes (repo_id, agent_id, kind, body, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      repoId,
      agentId,
      kind,
      clip(body, 4000),
      pinned ? 1 : 0,
      now(),
    );
    const who = agentId ? this.nameOf(agentId) : 'operator';
    this.event(repoId, agentId, 'note', `${who} noted [${kind}] ${clip(body, 120)}`);
    if (kind === 'decision' || kind === 'warning') {
      this.send(agentId ?? HUMAN, repoId, null, 'info', `📌 ${kind}: ${body}`);
    }
    return this.noteDto(this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id)!);
  }

  updateNote(id: number, patch: { pinned?: boolean; archived?: boolean }): void {
    const n = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id);
    if (!n) return;
    if (patch.pinned !== undefined) this.db.run('UPDATE notes SET pinned = ? WHERE id = ?', patch.pinned ? 1 : 0, id);
    if (patch.archived !== undefined) this.db.run('UPDATE notes SET archived_at = ? WHERE id = ?', patch.archived ? now() : null, id);
    this.bus.invalidate(`repo:${n.repo_id}`);
  }

  // ------------------------------------------------------ summaries (text)

  private agentLine(x: AgentRow, claims: ClaimRow[]): string {
    const mine = claims.filter((c) => c.agent_id === x.id);
    const parts = [`${x.name} [${x.status}]`, x.branch ?? 'no branch'];
    if (x.intent) parts.push(`intent: "${x.intent}"`);
    if (mine.length) parts.push(`claims: ${mine.map((c) => `${c.pattern}${bool(c.exclusive) ? '(X)' : ''}`).join(', ')}`);
    parts.push(`seen ${ago(x.last_seen)}`);
    return `- ${parts.join(' · ')}`;
  }

  statusText(agentId: string): string {
    const a = this.agent(agentId);
    if (!a) throw new Error('unknown session');
    const repo = this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', a.repo_id)!;
    const others = this.liveAgents(a.repo_id).filter((x) => x.id !== a.id);
    const claims = this.activeClaims(a.repo_id);
    const conflicts = this.db.all<ConflictRow>(
      "SELECT * FROM conflicts WHERE repo_id = ? AND status = 'open' AND (agent_a = ? OR agent_b = ?) ORDER BY id DESC LIMIT 10",
      a.repo_id,
      a.id,
      a.id,
    );
    const notes = this.db.all<NoteRow>('SELECT * FROM notes WHERE repo_id = ? AND pinned = 1 AND archived_at IS NULL ORDER BY id DESC LIMIT 10', a.repo_id);
    const unread = this.pending(a).length;
    const out = [`Repo ${repo.name} (${repo.root}). You are "${a.name}" on ${a.branch ?? 'no branch'}.`];
    out.push(others.length ? `Other agents online (${others.length}):\n${others.map((x) => this.agentLine(x, claims)).join('\n')}` : 'No other agents online.');
    const myClaims = claims.filter((c) => c.agent_id === a.id);
    if (myClaims.length) out.push(`Your claims: ${myClaims.map((c) => c.pattern).join(', ')}`);
    if (conflicts.length) {
      out.push(`Open conflicts involving you:\n${conflicts.map((c) => `- ${c.path} with ${this.nameOf(c.agent_a === a.id ? c.agent_b : c.agent_a)} (${c.kind})`).join('\n')}`);
    }
    if (notes.length) out.push(`Pinned notes:\n${notes.map((n) => `- [${n.kind}] ${clip(n.body, 300)}`).join('\n')}`);
    out.push(unread ? `Unread messages: ${unread} (sb_inbox).` : 'No unread messages.');
    return out.join('\n');
  }

  /** SessionStart context: short, only what a fresh session needs. */
  digest(agentId: string): string {
    const a = this.agent(agentId);
    if (!a) return '';
    const repo = this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', a.repo_id)!;
    const others = this.liveAgents(a.repo_id).filter((x) => x.id !== a.id);
    const notes = this.db.all<NoteRow>('SELECT * FROM notes WHERE repo_id = ? AND pinned = 1 AND archived_at IS NULL ORDER BY id DESC LIMIT 8', a.repo_id);
    if (!others.length && !notes.length) {
      return `Switchboard: you are "${a.name}", currently the only agent in ${repo.name}. Announce your task with sb_intent so agents joining later can see it.`;
    }
    const claims = this.activeClaims(a.repo_id);
    const out = [`Switchboard: you are "${a.name}" in ${repo.name}.`];
    if (others.length) out.push(`${others.length} other agent(s) are working in this repo:\n${others.slice(0, 12).map((x) => this.agentLine(x, claims)).join('\n')}`);
    if (notes.length) out.push(`Pinned notes:\n${notes.map((n) => `- [${n.kind}] ${clip(n.body, 300)}`).join('\n')}`);
    out.push('Announce your task with sb_intent (include the files you expect to touch) before editing.');
    return out.join('\n');
  }

  // --------------------------------------------------------- tool dispatch

  async runTool(agentId: string, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const a = this.agent(agentId);
    if (!a) return { text: 'Switchboard does not know this session yet; retry in a moment.', isError: true };
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
    try {
      switch (tool) {
        case 'sb_status':
          return { text: this.statusText(agentId), isError: false };
        case 'sb_intent': {
          const summary = str(args.summary);
          if (!summary) return { text: 'summary is required', isError: true };
          return { text: this.setIntent(agentId, summary, list(args.files), str(args.name)), isError: false };
        }
        case 'sb_claim': {
          const paths = list(args.paths);
          if (!paths.length) return { text: 'paths is required', isError: true };
          const ttl = typeof args.ttl_minutes === 'number' ? args.ttl_minutes : 60;
          return { text: this.claim(agentId, paths, args.exclusive === true, str(args.reason) ?? null, ttl), isError: false };
        }
        case 'sb_release':
          return { text: this.release(agentId, list(args.paths)), isError: false };
        case 'sb_send': {
          const body = str(args.body);
          const to = str(args.to);
          if (!body || !to) return { text: 'to and body are required', isError: true };
          const kind = (['info', 'question', 'request', 'handoff', 'warning'].includes(String(args.kind)) ? args.kind : 'info') as MessageKind;
          const replyTo = typeof args.reply_to === 'number' ? args.reply_to : null;
          const msg = this.send(agentId, a.repo_id, to, kind, body, args.urgent === true, replyTo);
          const wait = typeof args.await_reply_seconds === 'number' ? Math.min(600, Math.max(0, args.await_reply_seconds)) : 0;
          if (!wait) return { text: `Sent #${msg.id} to ${msg.toName ?? 'all'}.`, isError: false };
          const reply = await this.waitForReply(msg.id, wait * 1000);
          if (!reply) return { text: `Sent #${msg.id}; no reply within ${wait}s. Replies will show up in sb_inbox.`, isError: false };
          this.markDelivered([reply.id], agentId, 'tool');
          return { text: `Sent #${msg.id}. Reply #${reply.id} from ${reply.fromName}: ${reply.body}`, isError: false };
        }
        case 'sb_inbox':
          return { text: this.inbox(agentId, args.include_seen === true, typeof args.limit === 'number' ? args.limit : 30), isError: false };
        case 'sb_note': {
          const body = str(args.body);
          if (!body) return { text: 'body is required', isError: true };
          const kind = (['decision', 'fact', 'warning', 'todo'].includes(String(args.kind)) ? args.kind : 'fact') as NoteKind;
          const n = this.note(agentId, a.repo_id, kind, body, args.pin === true);
          return { text: `Noted #${n.id}${n.pinned ? ' (pinned)' : ''}.`, isError: false };
        }
        case 'sb_who_touches': {
          const paths = list(args.paths);
          if (!paths.length) return { text: 'paths is required', isError: true };
          return { text: this.whoTouches(agentId, paths), isError: false };
        }
        default:
          return { text: `Unknown tool ${tool}`, isError: true };
      }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
  }

  // ------------------------------------------------------------------ DTOs

  /**
   * Unread counts for a whole repo in one statement. Doing it per agent meant a correlated
   * NOT EXISTS over every message once per agent, which is the dominant cost on a busy repo.
   */
  private unreadByAgent(repoId: string): Map<string, number> {
    const agents = this.db.all<{ id: string; started_at: string; read_through_id: number }>(
      "SELECT id, started_at, read_through_id FROM agents WHERE repo_id = ? AND status <> 'offline'",
      repoId,
    );
    const head = this.db.get<{ n: number | null }>('SELECT MAX(id) AS n FROM messages WHERE repo_id = ?', repoId)?.n ?? 0;
    const out = new Map<string, number>();
    for (const a of agents) {
      // Walks forward from the watermark over the repo's (repo_id, id) index and stops as soon as
      // it has enough for the badge. An agent that is up to date scans nothing; one that is far
      // behind stops after the cap instead of walking its whole backlog.
      const rows = this.db.all<{ id: number }>(
        `SELECT m.id FROM messages m
          WHERE m.repo_id = ? AND m.id > ? AND m.from_id <> ? AND (m.to_id = ? OR m.to_id IS NULL) AND m.created_at >= ?
            AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = ?)
          ORDER BY m.id LIMIT ?`,
        repoId,
        a.read_through_id,
        a.id,
        a.id,
        a.started_at,
        a.id,
        UNREAD_CAP,
      );
      out.set(a.id, rows.length);
      const to = rows.length ? rows[0].id - 1 : head;
      if (to > a.read_through_id) this.db.run('UPDATE agents SET read_through_id = ? WHERE id = ? AND read_through_id < ?', to, a.id, to);
    }
    return out;
  }

  agentDto(r: AgentRow, unread?: number): Agent {
    return {
      id: r.id,
      repoId: r.repo_id,
      name: r.name,
      worktree: r.worktree,
      branch: r.branch,
      cwd: r.cwd,
      status: r.status,
      intent: r.intent,
      subscriptionId: r.subscription_id,
      runId: r.run_id,
      hasChannel: bool(r.has_channel),
      lastTool: r.last_tool,
      unread: r.status === 'offline' ? 0 : (unread ?? this.pending(r).length),
      startedAt: r.started_at,
      lastSeen: r.last_seen,
      endedAt: r.ended_at,
    };
  }

  private messageDto(m: MessageRow, name = (id: string | null) => this.nameOf(id), delivered?: number): Message {
    const count = delivered ?? this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE message_id = ?', m.id)?.n ?? 0;
    return {
      id: m.id,
      repoId: m.repo_id,
      from: m.from_id,
      fromName: name(m.from_id),
      to: m.to_id,
      toName: m.to_id ? name(m.to_id) : null,
      kind: m.kind,
      body: m.body,
      urgent: bool(m.urgent),
      replyTo: m.reply_to,
      createdAt: m.created_at,
      deliveredCount: count,
    };
  }

  private noteDto(n: NoteRow, name = (id: string | null) => this.nameOf(id)): Note {
    return {
      id: n.id,
      repoId: n.repo_id,
      agentId: n.agent_id,
      agentName: n.agent_id ? name(n.agent_id) : 'operator',
      kind: n.kind,
      body: n.body,
      pinned: bool(n.pinned),
      createdAt: n.created_at,
    };
  }

  private repoDto(r: RepoRow): Repo {
    const counts = this.db.get<{ online: number; total: number }>(
      "SELECT SUM(status <> 'offline') AS online, COUNT(*) AS total FROM agents WHERE repo_id = ?",
      r.id,
    );
    const conflicts = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conflicts WHERE repo_id = ? AND status = 'open'", r.id)?.n ?? 0;
    const unread = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE repo_id = ? AND to_id = 'human' AND human_read_at IS NULL", r.id)?.n ?? 0;
    return {
      id: r.id,
      root: r.root,
      name: r.name,
      agentsOnline: counts?.online ?? 0,
      agentsTotal: counts?.total ?? 0,
      openConflicts: conflicts,
      unreadForHuman: unread,
      lastActivity: r.last_activity,
    };
  }

  listRepos(): Repo[] {
    return this.db.all<RepoRow>('SELECT * FROM repos ORDER BY last_activity DESC').map((r) => this.repoDto(r));
  }

  repoExists(id: string): boolean {
    return !!this.db.get('SELECT 1 FROM repos WHERE id = ?', id);
  }

  agentsOnline(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE status <> 'offline'")?.n ?? 0;
  }

  repoDetail(repoId: string, limits: DetailLimits = DEFAULT_LIMITS): RepoDetail | null {
    const repo = this.db.get<RepoRow>('SELECT * FROM repos WHERE id = ?', repoId);
    if (!repo) return null;
    const name = this.namesIn(repoId);
    const unread = this.unreadByAgent(repoId);
    const agents = [
      ...this.db.all<AgentRow>("SELECT * FROM agents WHERE repo_id = ? AND status <> 'offline' ORDER BY started_at", repoId),
      ...this.db.all<AgentRow>("SELECT * FROM agents WHERE repo_id = ? AND status = 'offline' ORDER BY last_seen DESC LIMIT 30", repoId),
    ];
    const claims: Claim[] = this.activeClaims(repoId).map((c) => ({
      id: c.id,
      repoId: c.repo_id,
      agentId: c.agent_id,
      agentName: c.agent_name,
      pattern: c.pattern,
      exclusive: bool(c.exclusive),
      reason: c.reason,
      createdAt: c.created_at,
      expiresAt: c.expires_at,
    }));
    const conflicts: Conflict[] = this.db
      .all<ConflictRow>(
        "SELECT * FROM conflicts WHERE repo_id = ? AND (status = 'open' OR resolved_at >= ?) ORDER BY (status = 'open') DESC, id DESC LIMIT 50",
        repoId,
        new Date(Date.now() - 24 * 3600_000).toISOString(),
      )
      .map((c) => ({
        id: c.id,
        repoId: c.repo_id,
        path: c.path,
        kind: c.kind,
        status: c.status,
        agentA: c.agent_a,
        agentAName: name(c.agent_a),
        agentB: c.agent_b,
        agentBName: name(c.agent_b),
        detail: c.detail,
        createdAt: c.created_at,
        resolvedAt: c.resolved_at,
      }));
    const notes = this.db
      .all<NoteRow>('SELECT * FROM notes WHERE repo_id = ? AND archived_at IS NULL ORDER BY pinned DESC, id DESC LIMIT 200', repoId)
      .map((n) => this.noteDto(n, name));
    const messageRows = this.db.all<MessageRow>('SELECT * FROM messages WHERE repo_id = ? ORDER BY id DESC LIMIT ?', repoId, limits.messages).reverse();
    const deliveredCounts = new Map<number, number>();
    if (messageRows.length) {
      const ids = messageRows.map((m) => m.id);
      const placeholders = ids.map(() => '?').join(',');
      for (const row of this.db.all<{ message_id: number; n: number }>(
        `SELECT message_id, COUNT(*) AS n FROM deliveries WHERE message_id IN (${placeholders}) GROUP BY message_id`,
        ...ids,
      )) {
        deliveredCounts.set(row.message_id, row.n);
      }
    }
    const messages = messageRows.map((m) => this.messageDto(m, name, deliveredCounts.get(m.id) ?? 0));
    const events: FeedEvent[] = this.db
      .all<{ id: number; repo_id: string; agent_id: string | null; type: string; summary: string; ts: string }>(
        'SELECT * FROM events WHERE repo_id = ? ORDER BY id DESC LIMIT ?',
        repoId,
        limits.events,
      )
      .map((e) => ({ id: e.id, repoId: e.repo_id, agentId: e.agent_id, agentName: e.agent_id ? name(e.agent_id) : null, type: e.type, summary: e.summary, ts: e.ts }));
    const files: FileTouch[] = this.db
      .all<{ path: string; agent_id: string; worktree: string | null; n: number; last: string }>(
        // Aggregate the most recent slice of touches, not every touch in the window: a dozen busy
        // agents produce tens of thousands a day, and the panel only shows the newest rows anyway.
        // Counts are therefore "within the last TOUCH_SCAN rows", which is what the UI states.
        `SELECT path, agent_id, worktree, COUNT(*) AS n, MAX(ts) AS last
           FROM (SELECT * FROM file_touches WHERE repo_id = ? AND ts >= ? ORDER BY id DESC LIMIT ?)
          GROUP BY path, agent_id ORDER BY last DESC LIMIT ?`,
        repoId,
        new Date(Date.now() - 24 * 3600_000).toISOString(),
        TOUCH_SCAN,
        limits.files,
      )
      .map((f) => ({ path: f.path, agentId: f.agent_id, agentName: name(f.agent_id), worktree: f.worktree, count: f.n, lastTs: f.last }));
    return {
      repo: this.repoDto(repo),
      agents: agents.map((x) => this.agentDto(x, unread.get(x.id) ?? 0)),
      claims,
      conflicts,
      notes,
      messages,
      events,
      files,
    };
  }
}
