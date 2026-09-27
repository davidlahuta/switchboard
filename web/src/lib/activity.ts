import { SCHEDULED_WORK, type Run, type SessionWork } from '@shared/types.ts';
import { clockTime, formatDuration } from './time.ts';

/**
 * How long a working session may go without writing anything before the list points it out.
 * A foreground recipe can legitimately run this long, so it is said, not alarmed about, until
 * QUIET_WARN_MS.
 */
export const QUIET_NOTE_MS = 5 * 60_000;
export const QUIET_WARN_MS = 30 * 60_000;

/** Work that is running, as opposed to booked to start the session later. */
export function runningWork(run: Run): SessionWork[] {
  return (run.work ?? []).filter((w) => !SCHEDULED_WORK.includes(w.kind));
}

export function scheduledWork(run: Run): SessionWork[] {
  return (run.work ?? []).filter((w) => SCHEDULED_WORK.includes(w.kind));
}

const KIND: Record<SessionWork['kind'], string> = {
  subagent: 'subagent',
  workflow: 'workflow',
  shell: 'background shell',
  monitor: 'monitor',
  wakeup: '/loop wake-up',
  cron: 'scheduled prompt',
};

/** One line per piece of work: what it is, how long it has run, and when it last showed life. */
export function workLines(work: SessionWork[], now: number): string {
  return work
    .map((w) => {
      const parts = [KIND[w.kind] + (w.label ? `: ${w.label}` : '')];
      if (w.kind === 'wakeup' || w.kind === 'cron') {
        if (w.until) parts.push(`fires ${clockTime(w.until)}`);
      } else {
        parts.push(`running ${formatDuration(now - Date.parse(w.since))}`);
        const silent = now - Date.parse(w.lastSeen);
        if (silent > 60_000) parts.push(`last sign of life ${formatDuration(silent)} ago`);
        if (w.until) parts.push(`times out ${clockTime(w.until)}`);
      }
      return `• ${parts.join(' · ')}`;
    })
    .join('\n');
}

/** How long the main thread has gone without writing to its transcript or calling a hook. */
export function quietMs(run: Run, now: number): number {
  const seen = Date.parse(run.lastActivity);
  return Number.isFinite(seen) ? Math.max(0, now - seen) : 0;
}

/** The status in a sentence, for the pill's tooltip: what, since when, and in which tool. */
export function statusDetail(run: Run, now: number): string {
  const status = run.agentStatus ?? run.status;
  const since = run.agentStatusSince ? ` for ${formatDuration(now - Date.parse(run.agentStatusSince))}` : '';
  const tool = run.lastTool && (status === 'working' || status === 'waiting') ? `, in ${run.lastTool}` : '';
  const quiet = quietMs(run, now);
  const silence = status === 'working' && quiet > 60_000 ? `. Nothing written for ${formatDuration(quiet)}` : '';
  return `Agent ${status}${since}${tool}${silence}. Kept true by the session's hooks, and by its transcript when a hook is missed.`;
}
