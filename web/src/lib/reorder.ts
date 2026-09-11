import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Long enough to follow a row across a list, short enough not to be in the way of reading it. */
const SLIDE_MS = 320;
/** How long a row stays lit after something about it changes. */
const FLASH_MS = 1400;
/** A row that only moved is lit for less: the slide has already said where it went. */
const MOVE_FLASH_MS = 900;

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Slide rows to their new places instead of teleporting them, and light one up when it changes.
 *
 * These lists re-sort themselves under the reader: a session finishes a turn, or says something,
 * and jumps several places. Redrawn instantly that is a list which is different from the one you
 * were reading, with no way to tell whether a row moved, another row moved past it, or the thing
 * you were looking at is now somewhere else entirely. Moving through the change answers all three
 * without the reader having to re-scan.
 *
 * Motion answers "what moved". The light answers "what changed", which is not the same question: a
 * session that starts working, picks up a subagent, stalls or has a restart queued behind it may
 * not move at all, and on a desk of nine sessions the whole point of glancing at the list is to see
 * that something is alive. So a row is lit when its state changes, and lit more faintly when it
 * only changed places — the slide has already said that part.
 *
 * The technique is FLIP: the browser has already laid the new order out by the time this runs, so
 * each row is put back where it was with a transform and then released, and the transition does the
 * rest. Positions are read once per render into a map, which is also how a row that is new — or one
 * whose state changed — is recognised.
 *
 * Rows opt in with `data-reorder-key`, and may carry `data-mark`, `data-state` and `data-tone`;
 * anything else in the container is left alone.
 */
export function useReorder(container: RefObject<HTMLElement | null>, signature: string): void {
  const places = useRef(new Map<string, number>());
  const states = useRef(new Map<string, string>());
  const first = useRef(true);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const rows = root.querySelectorAll<HTMLElement>('[data-reorder-key]');
    const nextPlaces = new Map<string, number>();
    const nextStates = new Map<string, string>();
    const moved: Array<{ row: HTMLElement; by: number }> = [];
    const lit: HTMLElement[] = [];
    const nudged: HTMLElement[] = [];

    for (const row of rows) {
      const key = row.dataset.reorderKey ?? '';
      const top = row.offsetTop;
      const state = `${row.dataset.mark ?? ''}|${row.dataset.state ?? ''}`;
      nextPlaces.set(key, top);
      nextStates.set(key, state);
      const wasAt = places.current.get(key);
      const wasState = states.current.get(key);
      const didMove = wasAt !== undefined && wasAt !== top;
      if (didMove) moved.push({ row, by: wasAt - top });
      // A row that is new to the list is not a change; it has nothing to have changed from, and
      // lighting every row on the first paint would say everything is alive when nothing is.
      if (!first.current && wasState !== undefined && wasState !== state) lit.push(row);
      else if (didMove) nudged.push(row);
    }
    places.current = nextPlaces;
    states.current = nextStates;
    const wasFirst = first.current;
    first.current = false;
    if (wasFirst || reducedMotion()) return;

    for (const { row, by } of moved) {
      row.style.transition = 'none';
      row.style.transform = `translateY(${by}px)`;
    }
    for (const row of lit) flash(row, 'row-lit', FLASH_MS);
    for (const row of nudged) flash(row, 'row-moved', MOVE_FLASH_MS);
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

function flash(row: HTMLElement, className: string, ms: number): void {
  row.classList.remove(className);
  // Reading offsetWidth restarts an animation that is already running, which is what a row that
  // changes twice inside the window needs.
  void row.offsetWidth;
  row.classList.add(className);
  window.setTimeout(() => row.classList.remove(className), ms);
}

/**
 * What the rows are, in order and in state, so the effect runs when any of that changes and not on
 * every snapshot the daemon sends.
 */
export function orderOf(rows: Array<{ id: string; mark: string; state?: string }>): string {
  return rows.map((r) => `${r.id}:${r.mark}:${r.state ?? ''}`).join('|');
}
