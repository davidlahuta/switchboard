import { atRest, sessionGroup } from './marks.ts';
import type { Run } from './types.ts';

/** Whether nothing moves in this session until the operator does something. */
export function needsYou(run: Run): boolean {
  if (run.status === 'exited') return false;
  return run.attention.waiting || (!!run.stalled && !run.stalled.nextTry);
}

/**
 * Whether a session is finished for now: running, its turn over, and nothing of its own going or
 * booked — no subagent, workflow, shell, monitor, loop or schedule. A restart queued for it, or one
 * in flight, is not finished: it is about to come back.
 */
export function isDone(run: Run): boolean {
  return run.status === 'running' && !run.waiting && atRest(run) && !needsYou(run);
}

/**
 * The number on the app's icon: sessions that are waiting on the operator now. One that asked a
 * question or stalled, one that wrote to them with sb_send, and one that has just finished a turn
 * nobody has looked at. A session that has gone quiet long enough to be parked (see sessionGroup) is
 * not counted for being finished: it was left, and a number that only ever grows is one nobody reads.
 *
 * The same rule on the page (which sets it while open) and in every notification (which sets it
 * while the app is closed), so the number does not depend on which set it last.
 */
export function appBadgeCount(runs: readonly Run[], now = Date.now()): number {
  let n = 0;
  for (const r of runs) {
    const group = sessionGroup(r, now);
    if (group === 'needs-you' || group === 'messages' || (group === 'active' && isDone(r) && r.attention.unseen)) n++;
  }
  return n;
}
