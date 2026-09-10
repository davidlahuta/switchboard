import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Long enough to follow a row across a list, short enough not to be in the way of reading it. */
const SLIDE_MS = 320;
/** How long a row stays lit after the mark it carries changes. */
const FLASH_MS = 1400;

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Slide rows to their new places instead of teleporting them, and light one up when what it is
 * asking for changes.
 *
 * These lists re-sort themselves under the reader: a session finishes a turn, or says something,
 * and jumps several places. Redrawn instantly that is a list which is different from the one you
 * were reading, with no way to tell whether a row moved, another row moved past it, or the thing
 * you were looking at is now somewhere else entirely. Moving through the change answers all three
 * without the reader having to re-scan.
 *
 * The technique is FLIP: the browser has already laid the new order out by the time this runs, so
 * each row is put back where it was with a transform and then released, and the transition does the
 * rest. Positions are read once per render into a map, which is also how a row that is new — or one
 * whose mark changed — is recognised.
 *
 * Rows opt in with `data-reorder-key`, and may carry `data-mark`; anything else in the container is
 * left alone.
 */
export function useReorder(container: RefObject<HTMLElement | null>, signature: string): void {
  const places = useRef(new Map<string, number>());
  const marks = useRef(new Map<string, string>());
  const first = useRef(true);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const rows = root.querySelectorAll<HTMLElement>('[data-reorder-key]');
    const nextPlaces = new Map<string, number>();
    const nextMarks = new Map<string, string>();
    const moved: Array<{ row: HTMLElement; by: number }> = [];
    const lit: HTMLElement[] = [];

    for (const row of rows) {
      const key = row.dataset.reorderKey ?? '';
      const top = row.offsetTop;
      const mark = row.dataset.mark ?? '';
      nextPlaces.set(key, top);
      nextMarks.set(key, mark);
      const was = places.current.get(key);
      if (was !== undefined && was !== top) moved.push({ row, by: was - top });
      // A row that has just started asking for something. Not one that has stopped: a session going
      // quiet is not news, and lighting it up on the way out would draw the eye to the wrong row.
      if (mark && !first.current && marks.current.get(key) !== undefined && marks.current.get(key) !== mark) lit.push(row);
    }
    places.current = nextPlaces;
    marks.current = nextMarks;
    const wasFirst = first.current;
    first.current = false;
    if (wasFirst || reducedMotion()) return;

    for (const { row, by } of moved) {
      row.style.transition = 'none';
      row.style.transform = `translateY(${by}px)`;
    }
    for (const row of lit) {
      row.classList.remove('row-lit');
      // Reading offsetWidth restarts an animation that is already running, which is what a row
      // whose mark changes twice inside the window needs.
      void row.offsetWidth;
      row.classList.add('row-lit');
      window.setTimeout(() => row.classList.remove('row-lit'), FLASH_MS);
    }
    if (!moved.length) return;
    // Released in the same tick after one forced reflow, rather than on the next animation frame.
    // A frame can be cancelled — these lists re-render whenever anything in the repo changes — and
    // a row released by nobody keeps the transform that was holding it in its old place, stranded
    // there until something else moves it.
    void root.offsetWidth;
    for (const { row } of moved) {
      row.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0.75, 0.25, 1)`;
      row.style.transform = '';
    }
  }, [container, signature]);
}

/** What the rows are, in order, so the effect runs when that changes and not on every snapshot. */
export function orderOf(rows: Array<{ id: string; mark: string }>): string {
  return rows.map((r) => `${r.id}:${r.mark}`).join('|');
}
