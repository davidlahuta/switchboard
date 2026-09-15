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
 * How long a session may go without a sign of life before the desk stops calling it active.
 *
 * Long enough to cover a session that is genuinely mid-something without hooks firing — a long
 * build, a slow subagent, a turn that is thinking — and short enough that a session nobody has
 * touched since this morning is not still presented as part of today's work. A session that is
 * demonstrably busy is never judged by this; see sessionGroup.
 */
export const QUIET_AFTER_MS = 30 * 60_000;

/**
 * Which part of the desk a session belongs to.
 *
 * A list of sessions answers one question before any other: what should I look at first? The old
 * order answered it with attentionRank and then "whatever moved last", and got both halves wrong
 * once there were more than a few sessions on the desk.
 *
 * Wrong at the top, because "has done something you have not read" never expires. A session parked
 * a week ago, finished and unread, outranked every session that was actually running — permanently,
 * and there was nothing to do about it short of opening a terminal nobody wanted to open. The two
 * sessions the operator had left alone sat at the head of both lists all week.
 *
 * Wrong underneath, because `lastActivity` is the agent's last hook, and a working session fires
 * one every few seconds. Sorting on it meant the list re-ordered itself continuously: rows the
 * reader was aiming at moved out from under them, and nothing about the movement carried any
 * information, because every session was doing it.
 *
 * So the question is asked once, coarsely, and the answer is a place to stand rather than a score.
 * Inside a group nothing moves at all — see byAttention — and a row that does move has changed
 * group, which is the only movement worth a reader's attention. Everything finer than the group is
 * said by the mark, in place, where lib/reorder.ts lights it without moving it.
 */
export type SessionGroup = 'needs-you' | 'messages' | 'active' | 'parked' | 'done';

/** Highest first: the order the groups are shown in, and the order they sort in. */
export const SESSION_GROUPS: readonly SessionGroup[] = ['needs-you', 'messages', 'active', 'parked', 'done'];

export const GROUP_LABEL: Record<SessionGroup, string> = {
  'needs-you': 'Needs you',
  messages: 'Said something to you',
  active: 'Active',
  parked: 'Parked',
  done: 'Exited',
};

export const GROUP_HINT: Record<SessionGroup, string> = {
  'needs-you': 'Stopped until you answer. Nothing else is coming for these.',
  messages: 'They have sent you something you have not read.',
  active: 'Working, or quiet for only a moment. These need nothing from you.',
  parked: 'Quiet for more than half an hour. Still here, still resumable.',
  done: 'Over. Their conversations are still on disk.',
};

export function sessionGroup(run: Run, now: number): SessionGroup {
  if (run.status === 'exited') return 'done';
  // Both kinds of blocked: stopped on a prompt, and having stopped trying to get past something.
  // They read the same to an operator — nothing happens here until you do something — so they
  // stand together rather than splitting the one group that must be read first.
  if (run.attention.waiting || (run.stalled && !run.stalled.nextTry)) return 'needs-you';
  if (run.attention.unread > 0) return 'messages';
  if (isAlive(run, now)) return 'active';
  return 'parked';
}

/**
 * Whether a session is part of what is going on right now.
 *
 * Deliberately generous, and deliberately not "is it busy this instant". A session that has just
 * ended a turn is still the thing the operator was working on a moment ago, and moving it the
 * instant it goes quiet would be the old churn wearing a different hat — it would leave the group
 * and come back on the next prompt. What it is doing, down to the subagent, is the mark's job.
 */
function isAlive(run: Run, now: number): boolean {
  if (run.agentStatus === 'working' || run.agentStatus === 'starting') return true;
  // Waiting out a limit, or retrying after a failed turn: it comes back on its own, with no help.
  if (run.agentStatus === 'limited' || run.stalled) return true;
  // Its own turn may be over while it still has subagents thinking or a shell running.
  if ((run.work ?? []).length > 0) return true;
  const seen = Date.parse(run.lastActivity);
  return Number.isFinite(seen) && now - seen < QUIET_AFTER_MS;
}

/**
 * One order for every list of sessions, so the overview and the sessions table cannot disagree
 * about what is at the top.
 *
 * Group first, then by name — not by what moved last. A name is the one thing about a session that
 * does not change while you are reading, so a list sorted by it holds still: `rakousko` is in the
 * same place this minute as last, and the operator can go to it without reading the list again.
 * That is worth more than knowing which session fired a hook most recently, which is a question
 * nobody was asking and the marks answer anyway.
 *
 * History is the exception: exited sessions are ordered newest-first, because the only thing
 * anybody wants from that group is the one that just stopped. They are frozen, so they cannot churn.
 */
export function byAttention(now: number): (a: Run, b: Run) => number {
  return (a, b) => {
    const ga = SESSION_GROUPS.indexOf(sessionGroup(a, now));
    const gb = SESSION_GROUPS.indexOf(sessionGroup(b, now));
    if (ga !== gb) return ga - gb;
    if (SESSION_GROUPS[ga] === 'done') return (b.endedAt ?? '').localeCompare(a.endedAt ?? '') || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  };
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
