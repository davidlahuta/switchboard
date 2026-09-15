import type { Run } from '@shared/types.ts';
import { sessionMark } from '@shared/marks.ts';

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
