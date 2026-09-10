import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { DB_PATH, ensureDirs } from '../config.ts';

// Each entry upgrades the schema by one version (PRAGMA user_version).
const MIGRATIONS: string[] = [
  `
  CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,
    config_dir TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    plan TEXT,
    rate_tier TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    last_error TEXT,
    usage_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE usage_history (
    id INTEGER PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    five_hour_pct REAL,
    seven_day_pct REAL
  );
  CREATE INDEX usage_history_sub_ts ON usage_history (subscription_id, ts);

  CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_activity TEXT
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    name TEXT NOT NULL,
    worktree TEXT,
    branch TEXT,
    cwd TEXT,
    pid INTEGER,
    status TEXT NOT NULL,
    intent TEXT,
    subscription_id TEXT,
    run_id TEXT,
    has_channel INTEGER NOT NULL DEFAULT 0,
    last_tool TEXT,
    started_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    ended_at TEXT,
    last_piggyback_at TEXT
  );
  CREATE INDEX agents_repo ON agents (repo_id);
  CREATE TABLE claims (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    pattern TEXT NOT NULL,
    exclusive INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    source TEXT NOT NULL DEFAULT 'claim',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    released_at TEXT
  );
  CREATE INDEX claims_repo ON claims (repo_id, released_at);
  CREATE TABLE file_touches (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    path TEXT NOT NULL COLLATE NOCASE,
    worktree TEXT,
    tool TEXT,
    ts TEXT NOT NULL
  );
  CREATE INDEX file_touches_repo_path ON file_touches (repo_id, path, ts);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0,
    reply_to INTEGER,
    human_read_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_repo ON messages (repo_id, id);
  CREATE TABLE deliveries (
    message_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    via TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    PRIMARY KEY (message_id, agent_id)
  );
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL,
    agent_id TEXT,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE conflicts (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL,
    path TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    agent_a TEXT NOT NULL,
    agent_b TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX conflicts_repo ON conflicts (repo_id, status);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL,
    agent_id TEXT,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE INDEX events_repo ON events (repo_id, id);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    last_cwd TEXT,
    repo_id TEXT,
    session_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    status TEXT NOT NULL,
    auto_swap INTEGER NOT NULL DEFAULT 1,
    swap_count INTEGER NOT NULL DEFAULT 0,
    worktree TEXT,
    resume INTEGER NOT NULL DEFAULT 0,
    pid INTEGER,
    cols INTEGER NOT NULL DEFAULT 120,
    rows INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER
  );
  CREATE TABLE swaps (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    from_sub TEXT,
    to_sub TEXT NOT NULL,
    reason TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen TEXT,
    revoked_at TEXT
  );
  `,
  `
  ALTER TABLE runs ADD COLUMN extra_args TEXT;
  ALTER TABLE runs ADD COLUMN version TEXT;
  `,
  `
  ALTER TABLE runs ADD COLUMN model TEXT;
  ALTER TABLE runs ADD COLUMN auto_compact INTEGER;
  ALTER TABLE runs ADD COLUMN auto_compact_tokens INTEGER;
  `,
  `
  ALTER TABLE runs ADD COLUMN skip_permissions INTEGER;
  `,
  `
  -- Busy repos: the unread-per-agent lookup probes deliveries by agent, and the file-activity
  -- panel scans a repo's touches by time. Neither was served by an existing index.
  CREATE INDEX deliveries_agent ON deliveries (agent_id, message_id);
  CREATE INDEX file_touches_repo_ts ON file_touches (repo_id, ts);
  CREATE INDEX messages_repo_created ON messages (repo_id, created_at);
  `,
  `
  -- Everything at or below the watermark has been accounted for for this agent: delivered, sent
  -- by it, addressed elsewhere, or older than it. Only the tail above it is ever examined, so
  -- "what has this agent not seen" costs the same on a repo with fifty messages and one with
  -- fifty thousand. Existing agents start at the newest message that predates them, which is
  -- exactly what the created_at >= started_at filter already excluded.
  ALTER TABLE agents ADD COLUMN read_through_id INTEGER NOT NULL DEFAULT 0;
  UPDATE agents SET read_through_id =
    COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.repo_id = agents.repo_id AND m.created_at < agents.started_at), 0);

  -- Last session title Claude Code reported. The name and this shadow diverging is how each side
  -- learns the other renamed the session; see RunManager.syncTitle.
  ALTER TABLE runs ADD COLUMN claude_title TEXT;
  `,
  `
  -- Whether this session is told to carry on when it comes back. NULL follows the global setting,
  -- like the other per-session overrides.
  ALTER TABLE runs ADD COLUMN continue_on_resume INTEGER;
  `,
  `
  -- A respawn waiting for the session's turn to end, as JSON, so it survives a daemon restart.
  -- See RunManager.savePending.
  ALTER TABLE runs ADD COLUMN pending_respawn TEXT;
  `,
  `
  -- When this session's terminal was last open in the web UI, which is how the sessions list knows
  -- whether what the session has done since is something the operator has already seen.
  ALTER TABLE runs ADD COLUMN last_viewed_at TEXT;
  -- Counting what the operator has not read, by the session that sent it, on every state snapshot.
  CREATE INDEX messages_human ON messages (to_id, human_read_at);
  `,
  `
  -- The conversation this session's process was told to resume, until it reports having it. Held
  -- here rather than in memory so a daemon restart between the spawn and the session's first hook
  -- cannot leave a failed resume looking like an ordinary /clear. See RunManager.rebind.
  ALTER TABLE runs ADD COLUMN resuming TEXT;
  `,
  `
  -- One agent held up by another's exclusive claim. Written when an edit is denied, so waiting is
  -- a fact on the board rather than something only the blocked agent knows: it is what lets a
  -- claim nobody is using be broken, and what makes a cycle of agents waiting on each other
  -- something the daemon can see. See Coordinator.noteBlock.
  CREATE TABLE blocks (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL,
    waiter_id TEXT NOT NULL,
    holder_id TEXT NOT NULL,
    claim_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    since TEXT NOT NULL,
    last_try TEXT NOT NULL,
    cleared_at TEXT
  );
  CREATE UNIQUE INDEX blocks_open ON blocks (waiter_id, claim_id);
  CREATE INDEX blocks_repo ON blocks (repo_id, cleared_at);
  `,
  `
  -- What set a swap going, as a word rather than as prose. The reason line beside it reads well and
  -- parses badly, so the history could say "usage limit on Max 20x" without the UI being able to
  -- tell an operator's click from a limit from an update. Rows written before this say nothing.
  ALTER TABLE swaps ADD COLUMN trigger_kind TEXT;
  `,
  `
  -- What a session has running besides its own turn: subagents, background shells, monitors.
  --
  -- The main thread going quiet is not the same as the session being done. Claude Code reports
  -- subagents starting and stopping, and stamps every hook a subagent causes with its agent_id;
  -- background shells and monitors announce themselves in the tool result that starts them. Held in
  -- the database rather than in memory because a daemon restart in the middle of a twenty-minute
  -- subagent must not forget it is there.
  CREATE TABLE session_work (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    started_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT
  );
  CREATE INDEX session_work_live ON session_work (session_id, ended_at);
  `,
];

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;
  private closed = false;

  /** False once closed. Async work in flight during shutdown must check this before querying. */
  get open(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.raw.close();
    } catch {
      // already closed by the runtime
    }
  }

  constructor(file = DB_PATH) {
    if (file !== ':memory:') ensureDirs();
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  private migrate(): void {
    const current = (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }
}

export const now = (): string => new Date().toISOString();
export const bool = (v: unknown): boolean => v === 1 || v === true;
