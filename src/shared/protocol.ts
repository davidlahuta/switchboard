import type { LimitCause } from './limits.ts';
// Internal WebSocket protocol between the daemon and its helpers (runner, MCP shim).

export interface SpawnSpec {
  runId: string;
  sessionId: string;
  resume: boolean;
  cwd: string;
  file: string;
  args: string[];
  /** Environment overrides; null removes the variable. */
  env: Record<string, string | null>;
  title: string;
  subscriptionLabel: string;
}

export interface ManualRunSpec {
  cwd: string;
  subscriptionId: string;
  name?: string;
  resumeSessionId?: string;
  model?: string;
  autoCompact?: boolean;
  autoCompactTokens?: number;
  skipPermissions?: boolean;
  args?: string[];
}

export type RunnerToDaemon =
  | { type: 'hello'; runId: string | null; manual?: ManualRunSpec; alive: boolean; pid: number | null; cols: number; rows: number; startedAt?: string }
  | { type: 'spawned'; pid: number; cols: number; rows: number }
  | { type: 'data'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'exit'; code: number | null; intentional: boolean }
  | { type: 'limit-detected'; text: string; cause: LimitCause };

export type DaemonToRunner =
  | { type: 'spawn'; spec: SpawnSpec }
  | { type: 'swap'; spec: SpawnSpec; banner: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'type'; text: string }
  | { type: 'redraw' }
  /** Session renamed: put it on the window this runner lives in. */
  | { type: 'title'; text: string }
  /** Web viewers are gone: hand the size back to the console the runner lives in. */
  | { type: 'restore-size' }
  | { type: 'stop' }
  | { type: 'error'; message: string };

export type ShimToDaemon =
  | { type: 'hello'; sessionId: string; pid: number | null; cwd: string; runId: string | null; channel: boolean }
  | { type: 'call'; id: number; tool: string; args: Record<string, unknown> };

export type DaemonToShim =
  | { type: 'welcome'; agentName: string }
  | { type: 'result'; id: number; text: string; isError: boolean }
  | { type: 'push'; content: string; meta: Record<string, string> };
