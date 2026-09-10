import type { Run } from './types.ts';

/**
 * The mark a session carries, in one vocabulary, wherever it is shown.
 *
 * A session appears in two places that cannot share a stylesheet: the web lists, and the title of
 * the terminal tab it lives in. They used to say different things — a coloured dot on one, nothing
 * at all on the other — so a wall of tabs and the session list could not be read the same way, and
 * the operator had to learn both. One definition, so they cannot drift again.
 */
export type MarkTone = 'blocked' | 'message' | 'unseen' | 'busy' | 'limited';

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
 * The same mark for a terminal tab, which also carries what the session is doing.
 *
 * The web lists say that in words, in a status pill an inch from the name, so a busy mark there
 * would only repeat it. A tab has room for one line and nothing else, and "is this one still
 * working or has it stopped?" is exactly what a strip of terminals is scanned for.
 */
export function tabMark(run: Run): SessionMark | null {
  const attention = attentionMark(run);
  if (attention) return attention;
  if (run.status === 'exited') return null;
  if (run.agentStatus === 'limited') return { glyph: '⏳', tone: 'limited', why: 'Waiting out a usage limit' };
  if (run.agentStatus === 'working' || run.agentStatus === 'starting') return { glyph: '●', tone: 'busy', why: 'Working' };
  return null;
}

/** A session's terminal tab title: its name, and what it wants. */
export function tabTitle(run: Run, name: string): string {
  const mark = tabMark(run);
  return mark ? `${mark.glyph} ${name}` : name;
}
