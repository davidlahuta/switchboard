import type { Run, SessionWork } from './types.ts';

/**
 * The mark a session carries, in one vocabulary, wherever it is shown.
 *
 * A session appears in two places that cannot share a stylesheet: the web lists, and the title of
 * the terminal tab it lives in. They used to say different things — a coloured dot on one, nothing
 * at all on the other — so a wall of tabs and the session list could not be read the same way, and
 * the operator had to learn both. One definition, and both surfaces draw all of it, so they cannot
 * drift again; only the colour is particular to the one that can show colour.
 */
export type MarkTone = 'blocked' | 'message' | 'unseen' | 'busy' | 'delegating' | 'background' | 'limited';

export interface SessionMark {
  /** Rendered as-is in a terminal tab title and in the web lists. */
  glyph: string;
  tone: MarkTone;
  /** Why it is there, for a tooltip and for screen readers. */
  why: string;
}

/**
 * What this session is asking of the operator, or null when it is idle and has been read.
 *
 * Ordered by how much it wants a person: stopped on a prompt only they can clear, then having
 * spoken to them, then merely having finished something nobody has looked at. Deliberately not a
 * busy indicator — a session mid-turn is working and will finish on its own, and a mark on every
 * row is a mark worth nothing. It is the empty ones that make the others carry.
 *
 * "Finished something" is decided in the daemon (see attentionFor), which knows whether the quiet
 * is a session that is done or one whose subagents are still going.
 */
export function attentionMark(run: Run): SessionMark | null {
  if (run.status === 'exited') return null;
  const { waiting, unread, unseen } = run.attention;
  if (waiting) return { glyph: '❗', tone: 'blocked', why: 'Waiting for you: it is stopped on a prompt only you can answer' };
  /*
   * A session that has been told to carry on as often as it is worth asking is waiting for a person
   * just as surely as one stopped on a prompt — it has stopped trying, and nothing else is coming
   * for it. It used to earn the mark for "finished something you have not read", which is what a
   * session that is done looks like, and sorted accordingly: below every session that had genuinely
   * finished in the last few minutes.
   */
  if (run.stalled && !run.stalled.nextTry) {
    return { glyph: '❗', tone: 'blocked', why: `Waiting for you: it stopped on ${run.stalled.reason} and has been asked to carry on as often as it is worth asking` };
  }
  if (unread > 0) return { glyph: '✉', tone: 'message', why: `${unread} message${unread === 1 ? '' : 's'} for you from this session` };
  if (unseen) return { glyph: '✓', tone: 'unseen', why: 'It has done something since you last opened its terminal' };
  return null;
}

/**
 * How loudly a session is asking for the operator: the higher, the sooner it wants them.
 *
 * The same order attentionMark reads in, as a number the lists can sort on. They used to sort on
 * "is it asking for me at all", which flattens the three into one group and then orders that group
 * by whatever moved last — so a session blocked on a question ten minutes ago sat below one that
 * finished a minute ago. One of those will do nothing whatever until a person answers it; the other
 * is done. Zero for a session that wants nothing, and for one that has exited: history sorts last
 * however loudly it was asking when it stopped.
 */
export function attentionRank(run: Run): number {
  if (run.status === 'exited') return 0;
  if (run.attention.waiting) return 4;
  if (run.stalled && !run.stalled.nextTry) return 3;
  if (run.attention.unread > 0) return 2;
  if (run.attention.unseen) return 1;
  return 0;
}

/**
 * The whole mark: what it is asking of the operator, and failing that, what it is doing.
 *
 * "Still working, or has it stopped?" is the other thing a list of sessions is scanned for, and a
 * terminal tab has one line to answer it in. The web lists also say it in a status pill, but the
 * mark is what the eye goes to first, and one that meant something different in the two places
 * would be worse than one that repeats a pill.
 */
export function sessionMark(run: Run): SessionMark | null {
  const attention = attentionMark(run);
  if (attention) return attention;
  if (run.status === 'exited') return null;
  if (run.agentStatus === 'limited') return { glyph: '⏳', tone: 'limited', why: 'Waiting out a usage limit' };
  if (run.agentStatus === 'working' || run.agentStatus === 'starting') return { glyph: '●', tone: 'busy', why: 'Working' };
  /*
   * The two states that look like idleness and are not. A session whose own turn has ended can
   * still have subagents thinking — spending, and lost if the session is taken down — and can still
   * have a shell or a monitor of its own running. Both used to show nothing at all, which read as
   * "finished", so a wall of tabs said a session was done minutes before it was.
   */
  // Defensive: a page can outlive the daemon build that served it, and a mark that throws would
  // take the whole list with it.
  const work = run.work ?? [];
  const subagents = countWork(work, 'subagent');
  if (subagents > 0) {
    return {
      glyph: '◐',
      tone: 'delegating',
      why: `Working through ${subagents} subagent${subagents === 1 ? '' : 's'}; its own turn has ended`,
    };
  }
  const background = work.length;
  if (background > 0) {
    return {
      glyph: '◌',
      tone: 'background',
      why: `Idle, with ${background} background task${background === 1 ? '' : 's'} of its own still running`,
    };
  }
  return null;
}

function countWork(work: SessionWork[], kind: SessionWork['kind']): number {
  return work.filter((w) => w.kind === kind).length;
}

/** A session's terminal tab title: its name, and what it wants. */
export function tabTitle(run: Run, name: string): string {
  const mark = sessionMark(run);
  return mark ? `${mark.glyph} ${name}` : name;
}

/**
 * Everything about a session worth noticing a change in, as one string.
 *
 * The mark answers "what does it want"; this answers "is anything happening at all". A session that
 * starts working, picks up a subagent, stalls, or has a restart queued behind it may carry the same
 * mark throughout and still be the most interesting row on the page — which is what a glance at a
 * list of nine sessions is for.
 */
export function liveState(run: Run): string {
  return [
    run.status,
    run.agentStatus ?? '-',
    run.subscriptionId,
    run.waiting?.kind ?? '-',
    run.stalled ? `stalled:${run.stalled.tries}` : '-',
    (run.work ?? []).length,
    run.attention.unread,
    run.staleRunner ? 'old' : '-',
  ].join('/');
}

/** How to colour a row that has just changed: the same vocabulary its mark uses. */
export function liveTone(run: Run): MarkTone | 'quiet' {
  return sessionMark(run)?.tone ?? 'quiet';
}
