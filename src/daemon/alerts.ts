import { atRest } from '../shared/marks.ts';
import type { Run } from '../shared/types.ts';
import { logger } from '../log.ts';
import type { PushMessage, PushService } from './push.ts';

const log = logger('alerts');

/**
 * How long a session has to stay at rest before it is called done. A subagent finishing is
 * followed within seconds by the session waking to read what it said, and a shell's end by the
 * session looking at its output; "done" in that gap would be wrong within the minute.
 */
export const DONE_SETTLE_MS = 60_000;
/** A question has to still be on screen a moment later: a permission asked and answered at once is not one. */
export const NEEDS_YOU_SETTLE_MS = 4000;

/** Whether nothing moves in this session until the operator does something. */
export function needsYou(run: Run): boolean {
  if (run.status === 'exited') return false;
  return run.attention.waiting || (!!run.stalled && !run.stalled.nextTry);
}

/**
 * Whether a session is finished for now: running, its turn over, and nothing of its own going or
 * booked — no subagent, workflow, shell, monitor, loop or schedule. A restart queued for it, or one
 * in flight, is not finished: it is about to come back.
 */
export function isDone(run: Run): boolean {
  return run.status === 'running' && !run.waiting && atRest(run) && !needsYou(run);
}

interface Seen {
  needsYouSince: number | null;
  notifiedNeedsYou: boolean;
  doneSince: number | null;
  notifiedDone: boolean;
  /** it has done something since it was last called done; a session idle since it opened has not */
  worked: boolean;
}

export interface AlertSource {
  runs(): Run[];
  /** The question a session is showing, if one can be read off its screen. */
  question(runId: string): string | null;
  /** What the session said last, from its transcript. */
  lastWords(runId: string): string | null;
}

/**
 * Notifications for the two moments an operator away from the desk wants to hear about: a session
 * that is waiting for them, and a session that has finished everything it had going.
 *
 * Decided from the same Run the lists draw, so a notification and the row it points at agree. Each
 * moment is told once, when a session moves into it and has stayed there a little while, and is
 * told again only after the session has left it. What was already true when the daemon started is
 * not news, so it is not sent.
 */
export class SessionAlerts {
  private readonly seen = new Map<string, Seen>();
  private readonly source: AlertSource;
  private readonly push: Pick<PushService, 'send'>;

  constructor(source: AlertSource, push: Pick<PushService, 'send'>) {
    this.source = source;
    this.push = push;
  }

  /** Look at every session once. Returns what was sent, for tests and the log. */
  tick(now = Date.now()): PushMessage[] {
    const out: PushMessage[] = [];
    const live = new Set<string>();
    for (const run of this.source.runs()) {
      if (run.status === 'exited') continue;
      live.add(run.id);
      const waiting = needsYou(run);
      const done = isDone(run);
      let s = this.seen.get(run.id);
      if (!s) {
        // First sight: whatever it is doing now was true before anyone could be told.
        // A session busy at that moment is still owed its "done" when it gets there.
        const busy = run.agentStatus === 'working' || (run.work ?? []).length > 0;
        this.seen.set(run.id, { needsYouSince: waiting ? now : null, notifiedNeedsYou: waiting, doneSince: done ? now : null, notifiedDone: done, worked: busy });
        continue;
      }
      if (!done) s.worked ||= run.agentStatus === 'working' || (run.work ?? []).length > 0;

      if (!waiting) {
        s.needsYouSince = null;
        s.notifiedNeedsYou = false;
      } else {
        s.needsYouSince ??= now;
        if (!s.notifiedNeedsYou && now - s.needsYouSince >= NEEDS_YOU_SETTLE_MS) {
          s.notifiedNeedsYou = true;
          out.push(this.needsYouMessage(run));
        }
      }

      if (!done) {
        s.doneSince = null;
        s.notifiedDone = false;
      } else {
        s.doneSince ??= now;
        if (!s.notifiedDone && now - s.doneSince >= DONE_SETTLE_MS) {
          s.notifiedDone = true;
          // A session that has sat idle since it opened has finished nothing.
          if (s.worked) out.push(this.doneMessage(run));
          s.worked = false;
        }
      }
    }
    for (const id of this.seen.keys()) if (!live.has(id)) this.seen.delete(id);
    for (const msg of out) {
      log.info('notifying', { kind: msg.kind, title: msg.title });
      void this.push.send(msg);
    }
    return out;
  }

  private needsYouMessage(run: Run): PushMessage {
    const body = run.stalled && !run.stalled.nextTry
      ? `It stopped on ${run.stalled.reason} and has stopped trying again.`
      : (this.source.question(run.id) ?? 'It is waiting for your answer.');
    return { kind: 'needsYou', title: `${run.name} needs you`, body: clip(body), url: `/#/sessions/${run.id}`, tag: `run-${run.id}` };
  }

  private doneMessage(run: Run): PushMessage {
    const said = this.source.lastWords(run.id);
    return {
      kind: 'done',
      title: `${run.name} is done`,
      body: clip(said ?? 'Its turn is over and nothing it started is still running.'),
      url: `/#/sessions/${run.id}`,
      tag: `run-${run.id}`,
    };
  }
}

function clip(text: string, n = 220): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * The question on a session's screen: the nearest line above the dialog's footer that asks
 * something. Claude Code draws a question, then the options, then "Enter to select" or "Enter to
 * confirm"; a permission prompt draws "Do you want to …?". Null when nothing on screen reads as one.
 */
export function questionOnScreen(screen: string): string | null {
  const lines = screen.split('\n').map((l) => l.replace(/[│╭╮╰╯─]/g, ' ').trim());
  const footer = lines.findLastIndex((l) => /Enter to (select|confirm)|Esc to cancel/i.test(l));
  const upTo = footer >= 0 ? footer : lines.length;
  for (let i = upTo - 1; i >= 0 && i >= upTo - 30; i--) {
    const l = lines[i]!;
    if (l.endsWith('?') && l.length > 3 && !/^\d+\.\s/.test(l)) return l.replace(/^[❯>●☐✔\s]+/, '');
  }
  return null;
}
