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
