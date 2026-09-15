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
  // A session with nothing to say still holds the column. The marks are a mix of emoji and text
  // glyphs and no two are the same width, so the names only line up if the slot is the same size
  // whatever is in it — and an empty one has to be there at all, or an unmarked row starts further
  // left than every marked one and the list reads as ragged.
  if (!mark) return <span className="attention attention-empty" aria-hidden="true" />;

  return (
    <span className={`attention attention-${mark.tone}`} role="status" title={mark.why} aria-label={mark.why}>
      <span aria-hidden="true">{mark.glyph}</span>
    </span>
  );
}
