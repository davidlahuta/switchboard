import { scopedBinds } from './limits.ts';
import type { Usage, UsageWindow } from './types.ts';

/**
 * How much a subscription can still do, in one unit, for every limit Anthropic puts on it.
 *
 * A plan has a five-hour window and a weekly one (and, on some plans, a weekly one per model), and
 * each is reported as a percentage of *itself*. The two are not the same size: a week holds several
 * five-hour windows' worth of usage. Reading "87% of the week gone" and "84% of the five hours left"
 * as the same kind of number put a subscription with more than half a five-hour window in hand at
 * 13%, and a total built on it at 31% of a desk that had over half its room.
 *
 * So everything is converted to one unit before it is compared, added or shown: **a unit is what a
 * Pro plan's five-hour window holds**, a plan's own five-hour window is its weight (Max 20× = 20),
 * and its week is `weight × weekWindows`, where `weekWindows` is how many five-hour windows a week
 * holds for that plan. That is measured from the desk's own usage history: spending moves both
 * windows at once, and the ratio of the two climbs is the ratio of their sizes (see weekWindowsFrom).
 * Six Max 20× accounts over two weeks agree on 4.0–4.4.
 *
 * What a subscription can use before a limit stops a session is then the smallest of the rooms left
 * under each ceiling, and every decision and every number on the page is that same figure.
 */

/** Utilisation assumed for a window that has not reported yet (no session has run on it). */
export const ASSUMED_PCT = 40;
/** A week in five-hour windows when the desk has no history to measure it from: what it measured in September 2026. */
export const DEFAULT_WEEK_WINDOWS = 4.2;
/** A week cannot hold less than one five-hour window, nor more than the 33.6 that fit in seven days. */
export const WEEK_WINDOWS_MIN = 1;
export const WEEK_WINDOWS_MAX = (7 * 24) / 5;
/** Less than this much of a five-hour window left under a ceiling, and that ceiling is spent. */
export const SPENT_FRACTION = 0.01;

/** The windows of a Usage, which is all any of this reads. */
export type Windows = { fiveHour?: UsageWindow | null; sevenDay?: UsageWindow | null; scoped?: Usage['scoped'] };

export type CeilingKind = 'fiveHour' | 'sevenDay' | 'scoped';

/** One limit and the room under it, in units. */
export interface CeilingRoom {
  kind: CeilingKind;
  /** "5-hour window", "week", "Fable week" */
  label: string;
  /** what Anthropic reports, 0–100, or null when it has not reported */
  pct: number | null;
  /** how much the ceiling holds when empty, in units */
  size: number;
  /** how much is left under it, in units */
  left: number;
  resetsAt: string | null;
}

export interface Room {
  /** what can be used before a limit stops a session: the room under the tightest ceiling, in units */
  now: number;
  /** that ceiling, or null when no window has reported anything */
  binding: CeilingRoom | null;
  /**
   * How much of a five-hour window's worth is gone, by whichever ceiling binds: 0 with a full window
   * and a week to back it, 100 with nothing left under some ceiling. What the proactive threshold,
   * "spent" and the rescue all compare against.
   */
  usedPct: number;
  /** what is left of the week, the account's or the model's, whichever is tighter, in units */
  week: number;
  /** what `now` becomes once the binding ceiling turns over */
  afterReset: number;
  ceilings: CeilingRoom[];
}

/** The model-scoped weekly windows that gate a session running `model`, beside the account-wide two. */
export function modelWindows(usage: Windows | null | undefined, model: string | null): Usage['scoped'] {
  return (usage?.scoped ?? []).filter((w) => scopedBinds(w.label, model));
}

function ceiling(kind: CeilingKind, label: string, w: UsageWindow | null | undefined, size: number): CeilingRoom {
  const pct = w ? w.pct : null;
  const used = Math.min(100, Math.max(0, pct ?? ASSUMED_PCT));
  return { kind, label, pct, size, left: size * (1 - used / 100), resetsAt: w?.resetsAt ?? null };
}

/**
 * Every ceiling over a subscription for a session running `model` (null: the account-wide two only).
 *
 * A model's own week is sized like the account's week. Nothing measures it separately yet — its
 * climbs are not in the history — so this is the one figure here that is assumed rather than
 * measured; a model week that is really smaller than the account's has less room than it shows.
 */
export function ceilingsOf(usage: Windows | null | undefined, weight: number, weekWindows: number, model: string | null = null): CeilingRoom[] {
  const week = weight * weekWindows;
  return [
    ceiling('fiveHour', '5-hour window', usage?.fiveHour, weight),
    ceiling('sevenDay', 'week', usage?.sevenDay, week),
    ...modelWindows(usage, model).map((w) => ceiling('scoped', `${w.label} week`, w, week)),
  ];
}

export function roomOf(usage: Windows | null | undefined, weight: number, weekWindows: number, model: string | null = null): Room {
  const ceilings = ceilingsOf(usage, weight, weekWindows, model);
  // The five-hour window wins a tie: it is the one that comes back first.
  const tight = ceilings.reduce((a, b) => (b.left < a.left ? b : a));
  const weeks = ceilings.filter((c) => c.kind !== 'fiveHour');
  return {
    now: tight.left,
    binding: ceilings.some((c) => c.pct !== null) ? tight : null,
    usedPct: weight > 0 ? Math.min(100, Math.max(0, 100 * (1 - tight.left / weight))) : 100,
    week: Math.min(...weeks.map((c) => c.left)),
    afterReset: Math.min(...ceilings.map((c) => (c === tight ? c.size : c.left))),
    ceilings,
  };
}

/** A ceiling with nothing worth a session left under it. */
export function isSpent(c: CeilingRoom, weight: number): boolean {
  return c.pct !== null && c.left < SPENT_FRACTION * weight;
}

/**
 * How many five-hour windows a week holds, from samples of both windows taken together.
 *
 * Every bit of usage counts against both windows at once, so between two samples the five-hour
 * window climbs by spend/W5 and the week by spend/W7, and the ratio of the climbs is W7/W5 whatever
 * was spent. Summed over many samples, the one-percent steps both are reported in average out.
 * Pairs where either window fell (it turned over) or that are far apart (the daemon was down, and a
 * turnover may be hidden in the gap) are left out. Null when there is too little to go on.
 */
export function weekWindowsFrom(
  samples: Array<{ ts: number; five: number | null; week: number | null }>,
  opts: { maxGapMs?: number; minWeekClimb?: number } = {},
): number | null {
  const maxGap = opts.maxGapMs ?? 20 * 60_000;
  let five = 0;
  let week = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.five === null || a.week === null || b.five === null || b.week === null) continue;
    if (b.ts - a.ts > maxGap) continue;
    const d5 = b.five - a.five;
    const d7 = b.week - a.week;
    if (d5 < 0 || d7 < 0) continue;
    five += d5;
    week += d7;
  }
  if (week < (opts.minWeekClimb ?? 20)) return null;
  return Math.min(WEEK_WINDOWS_MAX, Math.max(WEEK_WINDOWS_MIN, five / week));
}

/** "0.4 of a 5-hour window", "2 five-hour windows": room in terms of the plan it is on. */
export function windowsText(units: number, weight: number): string {
  if (weight <= 0) return '—';
  const w = units / weight;
  if (w >= 1.95) return `${w.toFixed(1).replace(/\.0$/, '')} five-hour windows`;
  if (w >= 0.95 && w < 1.05) return 'a whole five-hour window';
  return `${w < 0.1 ? w.toFixed(2) : w.toFixed(1)} of a five-hour window`;
}

/**
 * Which ceiling is holding a subscription back, and how much is left under it, in words: "62% of its
 * 5-hour window left", "its week has 0.5 of a five-hour window left (87% used)", "its week is spent".
 */
export function bindingText(room: Room, weight: number): string {
  const b = room.binding;
  if (!b) return 'no usage reported yet';
  const whose = b.kind === 'fiveHour' ? 'its 5-hour window' : `its ${b.label}`;
  if (isSpent(b, weight)) return `${whose} is spent`;
  if (b.kind === 'fiveHour') {
    const pct = Math.round((100 * room.now) / Math.max(weight, 1e-9));
    return pct >= 100 ? 'a whole 5-hour window left' : `${pct}% of its 5-hour window left`;
  }
  return `${whose} has ${windowsText(room.now, weight)} left (${Math.round(b.pct ?? 0)}% used)`;
}
