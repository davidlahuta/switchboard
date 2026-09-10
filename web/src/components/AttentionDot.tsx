import type { Run } from '@shared/types.ts';
import { attentionMark, sessionMark } from '@shared/marks.ts';

/**
 * Whether this session is asking for the operator.
 *
 * Not every mark: a session that is merely working carries one, and it does not want anything —
 * it will finish on its own. Sorting on that would put every busy session above the one that has
 * stopped and is waiting to be told what to do, which is the opposite of what the order is for.
 */
export function wantsAttention(run: Run): boolean {
  return attentionMark(run) !== null;
}

/**
 * One order for every list of sessions, so the overview and the sessions table cannot disagree
 * about which session is at the top.
 *
 * What wants the operator comes first — that is what a mark is for, and a list that shows marks and
 * then buries them below a dozen quiet rows has made the reader do the sorting. Then the most
 * recently active, because with a dozen sessions open the one being worked on is the one being
 * looked for; then by name, so a list of idle sessions holds still between refreshes rather than
 * shuffling on every tick. Sessions that have exited stay at the bottom whatever they are asking
 * for: they are history, and the live ones are the work.
 */
export function byAttention(a: Run, b: Run): number {
  return (
    Number(a.status === 'exited') - Number(b.status === 'exited') ||
    Number(wantsAttention(b)) - Number(wantsAttention(a)) ||
    b.lastActivity.localeCompare(a.lastActivity) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * The mark next to a session, so the list answers "which of these needs me, and which are still
 * going?" without opening any of them.
 *
 * The same character its terminal tab carries, down to the last state, so a wall of tabs and this
 * list read as one thing; see shared/marks.ts for what earns one. The colour is what this surface
 * can add and a tab title cannot.
 */
export function AttentionDot({ run }: { run: Run }) {
  const mark = sessionMark(run);
  if (!mark) return null;

  return (
    <span className={`attention attention-${mark.tone}`} role="status" title={mark.why} aria-label={mark.why}>
      <span aria-hidden="true">{mark.glyph}</span>
    </span>
  );
}
