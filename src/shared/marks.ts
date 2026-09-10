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
  if (unread > 0) return { glyph: '✉', tone: 'message', why: `${unread} message${unread === 1 ? '' : 's'} for you from this session` };
  if (unseen) return { glyph: '✓', tone: 'unseen', why: 'It has done something since you last opened its terminal' };
  return null;
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
