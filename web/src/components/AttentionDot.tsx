import type { Run } from '@shared/types.ts';

/**
 * A dot next to a session that wants looking at, so the list answers "which of these needs me?"
 * without opening any of them.
 *
 * It is deliberately not a busy indicator. A session mid-turn is working and will finish on its
 * own; marking that too would put a dot on nearly every row, and a dot on everything is a dot worth
 * nothing. What earns one is the session being stopped on something only a person can clear, having
 * addressed the operator directly, or having finished something nobody has read yet.
 */
/** Whether this session has a dot — the same test the dot itself makes. */
export function wantsAttention(run: Run): boolean {
  const { waiting, unread, unseen } = run.attention;
  return waiting || unread > 0 || unseen;
}

/**
 * One order for every list of sessions, so the overview and the sessions table cannot disagree
 * about which session is at the top.
 *
 * What wants the operator comes first — that is what a dot is for, and a list that shows dots and
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

export function AttentionDot({ run }: { run: Run }) {
  const { waiting, unread, unseen } = run.attention;
  if (!waiting && !unread && !unseen) return null;

  // Ordered by how much it wants you: blocked beats spoken-to beats merely unread.
  const [tone, why] = waiting
    ? (['blocked', 'Waiting for you: it is stopped on a prompt only you can answer'] as const)
    : unread
      ? (['message', `${unread} message${unread === 1 ? '' : 's'} for you from this session`] as const)
      : (['unseen', 'It has done something since you last opened its terminal'] as const);

  return <span className={`attention attention-${tone}`} role="status" title={why} aria-label={why} />;
}
