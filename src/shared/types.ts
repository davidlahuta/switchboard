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
  pid: number | null;
  cols: number;
  rows: number;
  createdAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

export interface Settings {
  /** Swap automatically when a session hits a usage limit */
  autoSwap: boolean;
  /** Swap idle sessions proactively once their subscription crosses swapThresholdPct */
  proactiveSwap: boolean;
  swapThresholdPct: number;
  /** Typed into the session after an automatic swap caused by a limit */
  continueMessage: string;
  usagePollSec: number;
  conflictWindowMin: number;
  /** Extra CLI args for every launched session, e.g. ["--permission-mode", "auto"] */
  claudeArgs: string[];
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
  /** resume an existing Claude session id */
  resumeSessionId?: string;
  autoSwap?: boolean;
}

export interface SwapRequest {
  /** subscription id or 'auto' */
  subscriptionId: string;
  /** swap even if the agent is mid-turn */
  force?: boolean;
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
  | { type: 'resize'; cols: number; rows: number };

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
