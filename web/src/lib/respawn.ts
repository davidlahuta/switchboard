import { readyForRespawn } from '@shared/respawn.ts';
import type { Run } from '@shared/types.ts';

/**
 * Whether a swap, restart or relaunch is actually under way for this session: it is going down or
 * coming back right now.
 *
 * A session with one merely queued reports the status "swapping" as well, and is still running its
 * turn. That one can be asked again — with Force now, to stop waiting — so it must not lock the
 * menus the way a respawn in flight does.
 */
export function respawnInFlight(run: Run): boolean {
  return run.status === 'swapping' && !run.waiting;
}

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
  // A session with something queued reads "swapping" but is running its turn like any other.
  if (force || (run.status !== 'running' && !run.waiting)) return false;
  return !readyForRespawn({ status: run.agentStatus, work: run.work });
}

/** What to tell the operator once the daemon has said which it did. */
export function respawnToast(run: Run, done: string, queued: string): string {
  return run.waiting ? `${run.name}: ${queued} when the current turn ends` : `${done} ${run.name}`;
}
