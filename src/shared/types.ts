// API contract shared by the daemon and the web UI. Keep this file dependency-free and
// erasable-syntax only: the daemon runs it directly with Node's type stripping.

export type SubscriptionKind = 'default' | 'profile';
export type SubscriptionStatus = 'pending_login' | 'ready' | 'logged_out' | 'error';

export interface UsageWindow {
  /** 0–100 */
  pct: number;
  /** ISO timestamp, null when the window has not started */
  resetsAt: string | null;
}

export interface Usage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** Model-scoped weekly limits (e.g. "Fable"), when the plan has them */
  scoped: Array<UsageWindow & { label: string }>;
  fetchedAt: string;
  source: 'oauth' | 'statusline';
  stale: boolean;
  error: string | null;
  /** Why the numbers are stale, so the UI can say "rate limited" rather than a generic failure */
  errorKind: 'rate_limited' | 'auth' | 'network' | 'token' | null;
  /** When polling resumes, while rate limited */
  retryAt: string | null;
}

export interface Subscription {
  id: string;
  label: string;
  kind: SubscriptionKind;
  configDir: string;
  email: string | null;
  displayName: string | null;
  /** 'max' | 'pro' | 'team' | ... as reported by the credentials */
  plan: string | null;
  rateTier: string | null;
  /** Relative capacity (pro = 1, max 5x = 5, max 20x = 20) used for aggregate totals */
  weight: number;
  /**
   * How much you can actually use right now, in capacity units: `weight` scaled by whichever of
   * the 5-hour and weekly windows is tighter. Sorting by this puts the subscription with the most
   * immediately available usage first. 0 for anything disabled or not logged in.
   */
  headroom: number;
  /** Which window is currently the binding constraint, or null while usage is unknown */
  bindingWindow: 'fiveHour' | 'sevenDay' | null;
  enabled: boolean;
  priority: number;
  status: SubscriptionStatus;
  lastError: string | null;
  usage: Usage | null;
  liveRuns: number;
  createdAt: string;
}

export interface UsagePoint {
  ts: string;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
}

/** A git repository found under one of the configured root folders. */
export interface DiscoveredRepo {
  /** Absolute path of the working directory a session would start in */
  path: string;
  name: string;
  branch: string | null;
  /** true for a linked worktree; it shares its main worktree's coordination group */
  isWorktree: boolean;
  /** Coordination group id, matching `Repo.id` once the repo is known */
  repoId: string;
  mainWorktree: string;
}

export interface Repo {
  id: string;
  root: string;
  name: string;
  agentsOnline: number;
  agentsTotal: number;
  openConflicts: number;
  unreadForHuman: number;
  lastActivity: string | null;
}

export type AgentStatus = 'starting' | 'working' | 'idle' | 'waiting' | 'limited' | 'offline';

/**
 * An agent's unread count stops being exact past this. It is a badge: the difference between 200
 * and 1700 does not change what the operator does, and counting exactly would mean walking every
 * message an agent behind on its inbox has not taken yet.
 */
export const UNREAD_CAP = 200;

export interface Agent {
  /** Claude Code session id */
  id: string;
  repoId: string;
  name: string;
  worktree: string | null;
  branch: string | null;
  cwd: string | null;
  status: AgentStatus;
  intent: string | null;
  subscriptionId: string | null;
  runId: string | null;
  hasChannel: boolean;
  lastTool: string | null;
  unread: number;
  startedAt: string;
  lastSeen: string;
  endedAt: string | null;
}

export interface Claim {
  id: number;
  repoId: string;
  agentId: string;
  agentName: string;
  pattern: string;
  exclusive: boolean;
  reason: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export type MessageKind = 'info' | 'question' | 'request' | 'handoff' | 'warning' | 'conflict';

export interface Message {
  id: number;
  repoId: string;
  /** agent id, 'human' or 'switchboard' */
  from: string;
  fromName: string;
  /** agent id, 'human', or null for broadcast */
  to: string | null;
  toName: string | null;
  kind: MessageKind;
  body: string;
  urgent: boolean;
  replyTo: number | null;
  createdAt: string;
  /** number of recipients that received it (push, hook or tool) */
  deliveredCount: number;
}

export type NoteKind = 'decision' | 'fact' | 'warning' | 'todo';

export interface Note {
  id: number;
  repoId: string;
  agentId: string | null;
  agentName: string;
  kind: NoteKind;
  body: string;
  pinned: boolean;
  createdAt: string;
}

export type ConflictKind = 'overlap' | 'claim';
export type ConflictStatus = 'open' | 'resolved' | 'dismissed';

export interface Conflict {
  id: number;
  repoId: string;
  path: string;
  kind: ConflictKind;
  status: ConflictStatus;
  agentA: string;
  agentAName: string;
  agentB: string;
  agentBName: string;
  detail: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface FeedEvent {
  id: number;
  repoId: string;
  agentId: string | null;
  agentName: string | null;
  type: string;
  summary: string;
  ts: string;
}

export interface FileTouch {
  path: string;
  agentId: string;
  agentName: string;
  worktree: string | null;
  count: number;
  lastTs: string;
}

export type RunStatus = 'starting' | 'running' | 'swapping' | 'exited' | 'disconnected';

export interface Swap {
  fromSubscriptionId: string | null;
  toSubscriptionId: string;
  reason: string;
  ts: string;
}

export interface Run {
  id: string;
  name: string;
  cwd: string;
  repoId: string | null;
  sessionId: string;
  subscriptionId: string;
  subscriptionLabel: string;
  status: RunStatus;
  agentStatus: AgentStatus | null;
  autoSwap: boolean;
  swapCount: number;
  lastSwap: Swap | null;
  /** per-session extra claude arguments */
  args: string[];
  model: string | null;
  autoCompact: boolean;
  autoCompactTokens: number;
  skipPermissions: boolean;
  /** told to carry on when it comes back, resolved against the global setting */
  continueOnResume: boolean;
  /** claude version this session is currently running on, when known */
  version: string | null;
  /**
   * The process hosting this session's terminal was started before the current Switchboard source
   * was written, so it is running older code. Only a relaunch (a fresh terminal tab) picks the
   * change up — restarting in place reuses the same host process.
   */
  staleRunner: boolean;
  /**
   * The directory this session works in is gone. It cannot be resumed there: Claude Code exits
   * immediately with a Windows "invalid directory" error, which says nothing about why.
   */
  cwdMissing: boolean;
  pid: number | null;
  cols: number;
  rows: number;
  createdAt: string;
  /**
   * Newest sign of life: the agent's last hook or MCP call, else the moment the run ended or
   * started. Sessions are listed by this, so the ones being worked on stay at the top.
   */
  lastActivity: string;
  endedAt: string | null;
  exitCode: number | null;
}

/** Whether the daemon is registered to start automatically (Windows Task Scheduler). */
export interface ServiceStatus {
  /** false on platforms where automatic start is not implemented */
  supported: boolean;
  installed: boolean;
  /** Task Scheduler state, e.g. Ready / Running / Disabled */
  state: string | null;
  lastRunTime: string | null;
  lastResult: string | null;
  /** the daemon answered /healthz just now */
  running: boolean;
  logPath: string;
}

export interface Model {
  id: string;
  displayName: string;
  maxInputTokens: number;
  maxOutputTokens: number | null;
}

export interface UpdateStatus {
  /** Version of the claude executable as of the last check */
  currentVersion: string | null;
  lastCheckAt: string | null;
  /** Most recent version change Switchboard observed */
  lastUpdate: { from: string; to: string; at: string } | null;
  /** A check is running right now */
  checking: boolean;
  lastError: string | null;
  /** Runs waiting to restart onto the new version (they restart when idle) */
  pendingRestarts: number;
}

export interface Settings {
  /** Periodically run `claude update` */
  autoUpdate: boolean;
  updateCheckHours: number;
  /** After an update lands, restart sessions so they run the new version */
  restartAfterUpdate: boolean;
  /** Defaults pre-filled into the new-session dialog */
  defaultModel: string | null;
  defaultAutoCompact: boolean;
  defaultAutoCompactTokens: number;
  /** Pre-tick "skip permission prompts" in the new-session dialog */
  defaultSkipPermissions: boolean;
  /** Swap automatically when a session hits a usage limit */
  autoSwap: boolean;
  /** Swap idle sessions proactively once their subscription crosses swapThresholdPct */
  proactiveSwap: boolean;
  swapThresholdPct: number;
  /**
   * Typed into a session once it is back at a prompt on a conversation it already had — after a
   * swap, a restart, a relaunch, or resuming an existing session id.
   */
  continueMessage: string;
  /**
   * Send it on every resume, not only on a swap made because a limit was hit. A session that
   * starts a new conversation never gets it: there is nothing yet to continue.
   */
  continueOnResume: boolean;
  usagePollSec: number;
  conflictWindowMin: number;
  /** Extra CLI args for every launched session, e.g. ["--permission-mode", "auto"] */
  claudeArgs: string[];
  /** Folders scanned for git repositories, so starting a session is a pick rather than a path */
  repoRoots: string[];
  /**
   * Where a new session's tab opens: 'current' joins the Windows Terminal window you were last
   * using (opening one if there is none), 'switchboard' keeps them together in a window of their
   * own. SWITCHBOARD_WT_WINDOW overrides both.
   */
  terminalWindow: 'current' | 'switchboard';
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string | null;
}

export interface DaemonInfo {
  version: string;
  port: number;
  dataDir: string;
  claudePath: string | null;
  wtAvailable: boolean;
  integrationInstalled: boolean;
  /** When this daemon process started */
  startedAt: string;
  /**
   * Newest mtime under src/. The daemon runs TypeScript straight from source, and the supervisor
   * only relaunches it when it exits, so after an edit or a git pull it would otherwise keep
   * serving old code indefinitely.
   */
  sourceChangedAt: string | null;
  /** Source has changed since this process started: it needs a restart to pick the change up. */
  staleCode: boolean;
  /** A supervisor (the logon task) will relaunch the daemon if it exits, so restarting is safe. */
  supervised: boolean;
  /**
   * Identifies the web build being served. A browser tab keeps the scripts it loaded for as long as
   * it stays open, so this changing is how an open tab learns it is running an older UI.
   */
  webBuildId: string;
  /** true when the current request is local (no pairing needed) */
  local: boolean;
}

export interface Totals {
  /** Sum of weights of enabled, ready subscriptions */
  capacity: number;
  /** Weighted remaining headroom in the 5h window, in the same units as capacity */
  fiveHourRemaining: number;
  sevenDayRemaining: number;
  liveRuns: number;
  agentsOnline: number;
}

export interface StateSnapshot {
  daemon: DaemonInfo;
  subscriptions: Subscription[];
  repos: Repo[];
  runs: Run[];
  settings: Settings;
  totals: Totals;
  update: UpdateStatus;
  /** Models offered when starting a session (1M-context only), from the API */
  models: Model[];
}

export interface RepoDetail {
  repo: Repo;
  agents: Agent[];
  claims: Claim[];
  conflicts: Conflict[];
  notes: Note[];
  messages: Message[];
  events: FeedEvent[];
  files: FileTouch[];
}

// ---- request bodies ----

export interface CreateRunRequest {
  cwd: string;
  /** subscription id or 'auto' */
  subscriptionId: string;
  name?: string;
  /** create a new git worktree with this name (claude --worktree) */
  worktree?: string;
  /** resume an existing Claude session id (a GUID; sessions are never addressed by name) */
  resumeSessionId?: string;
  autoSwap?: boolean;
  /** extra arguments appended to the claude command line for this session only */
  args?: string[];
  /** model id from the catalog; omit to use the Claude Code default */
  model?: string | null;
  autoCompact?: boolean;
  /** context tokens at which auto-compact triggers */
  autoCompactTokens?: number;
  /** run with --dangerously-skip-permissions (no tool approval prompts) */
  skipPermissions?: boolean;
  /** type the continue message when this session comes back; omit to follow the global setting */
  continueOnResume?: boolean;
}

/** Fields the operator can change on an existing session. */
export interface UpdateRunRequest {
  /**
   * Session name. Switchboard and Claude Code keep one name between them: this is pushed into the
   * session, and a /rename inside the session comes back the same way.
   */
  name?: string;
  autoSwap?: boolean;
  /** Type the continue message when this session comes back. Takes effect on its next resume. */
  continueOnResume?: boolean;
}

export interface RelaunchRequest {
  /** relaunch even if the agent is mid-turn */
  force?: boolean;
}

export interface SwapRequest {
  /** subscription id or 'auto' */
  subscriptionId: string;
  /** swap even if the agent is mid-turn */
  force?: boolean;
}

/** POST /api/runs/:id/restart — same subscription, resumes the same session GUID. */
export interface RestartRequest {
  /** restart even if the agent is mid-turn */
  force?: boolean;
}

/** POST /api/update/restart-sessions */
export interface RestartAllResult {
  queued: number;
}

export interface HumanMessageRequest {
  /** agent id or null for broadcast */
  to: string | null;
  body: string;
  kind?: MessageKind;
  /** message id being answered (threads the reply and wakes an agent waiting on it) */
  replyTo?: number | null;
}

/** GET /api/sessions/recent */
export interface RecentSession {
  id: string;
  title: string;
  /** ISO timestamp of the transcript's last write */
  mtime: string;
}

// ---- WebSocket frames ----

/** /ws/ui server → client */
export type UiFrame =
  | { type: 'invalidate'; scopes: string[] }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

/** /ws/term/:runId server → client */
export type TermServerFrame =
  | { type: 'snapshot'; data: string; cols: number; rows: number }
  | { type: 'data'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'status'; status: RunStatus; subscriptionLabel: string };

/**
 * /ws/term/:runId client → server.
 * `resize` makes the web view take over the PTY size (e.g. "fit to phone"); resizing the
 * Windows Terminal tab takes it back.
 */
export type TermClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  /** Stop driving the size from here: the console the session runs in owns it again. */
  | { type: 'release-size' };

// ---- auth / pairing ----

export interface AuthStatus {
  /** request is from the desk itself */
  local: boolean;
  /** request carries a valid device cookie */
  paired: boolean;
  deviceName: string | null;
}

export interface PairingCode {
  code: string;
  /** full URL to open on the device (uses the Host the local UI was opened with unless overridden) */
  expiresAt: string;
}

export interface IntegrationStatus {
  /** switchboard MCP server registered at user scope in ~/.claude.json */
  mcpInstalled: boolean;
  /** switchboard HTTP hooks present in ~/.claude/settings.json */
  hooksInstalled: boolean;
}
