import { readyForRespawn } from '@shared/respawn.ts';
import type { Run } from '@shared/types.ts';

/**
 * Whether a swap, restart or relaunch asked for right now would be queued behind the session's work
 * rather than taken immediately.
 *
 * The daemon decides this for real at the moment the request lands — a turn can end between
 * rendering a menu and clicking it — but it decides it with the same function, so the menu can say
 * which of the two the click is asking for rather than promising "now" and delivering "in twenty
 * minutes".
 */
export function willWaitForTurn(run: Run, force: boolean): boolean {
  if (force || run.status !== 'running') return false;
  return !readyForRespawn({ status: run.agentStatus, work: run.work });
}

/** What to tell the operator once the daemon has said which it did. */
export function respawnToast(run: Run, done: string, queued: string): string {
  return run.waiting ? `${run.name}: ${queued} when the current turn ends` : `${done} ${run.name}`;
}
