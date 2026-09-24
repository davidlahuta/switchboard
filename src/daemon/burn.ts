import type { BurnForecast, UsagePoint, UsageWindow } from '../shared/types.ts';
import { ceilingsOf } from '../shared/capacity.ts';

/**
 * When the desk runs out of usage, at the rate it is spending now.
 *
 * The per-subscription numbers answer "where should this session go"; they do not answer the
 * question an operator actually asks at four in the afternoon, which is whether the whole desk is
 * about to stop. That one is about the pool: eight sessions spread across four subscriptions spend
 * one budget, and either it lasts until the windows turn over or it does not.
 *
 * Everything here is in **capacity units** (see shared/capacity.ts): a 20x Max's five-hour window is
 * twenty times a Pro's, and its week is `weekWindows` of those windows. Percent is not addable across
 * plans, and it is not comparable across windows either — a point of a week is several points of a
 * five-hour window.
 *
 * The two windows are simulated together, as they apply. Simulated apart, the five-hour pool refilled
 * every five hours from subscriptions whose weeks were spent — capacity that exists on no account —
 * and the desk read "never runs out" on a Thursday with Friday's weeks already gone.
 */

/** Samples older than this say nothing about the rate right now. */
const LOOKBACK_H = 3;
/** Below this much measured time, a rate is noise. */
const MIN_SPAN_H = 0.5;
/** Rates under this are treated as nothing being spent at all, rather than as a very slow leak. */
const IDLE_RATE = 0.01;
/** How far ahead the desk is simulated before the answer is "never": past every weekly reset. */
const HORIZON_H = 8 * 24;
/** How long each window is, and so how long after a reset the next one comes. */
export const WINDOW_H = { fiveHour: 5, sevenDay: 7 * 24 } as const;
/** Simulation step. Fine enough to land a forecast on the right ten minutes. */
const STEP_H = 1 / 12;
/** Room below this, in units, is none. */
const EPS = 1e-6;

export interface BurnSub {
  id: string;
  weight: number;
  /** how many five-hour windows its week holds */
  weekWindows: number;
  /** that figure was measured from history rather than assumed */
  measured?: boolean;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** until when it takes nothing, having hit its spend cap (ms), or null */
  blockedUntil?: number | null;
  /** oldest first */
  history: Array<{ ts: number; five: number | null; week: number | null }>;
}

export interface BurnInput {
  /** enabled, ready subscriptions only: anything else cannot absorb a session */
  subs: BurnSub[];
  now: number;
}

/**
 * How fast the pool is being spent, in units per hour.
 *
 * Measured from the samples rather than from anything Claude Code reports, because nothing reports
 * it. Each subscription's climbs are scaled to units: the five-hour window's by its weight, which is
 * the finer reading; across a five-hour turnover, where that window fell, the week's climb stands in,
 * scaled by the week's size. A fall is a window turning over, not usage handed back.
 */
export function burnRate(input: BurnInput): { rate: number; spanHours: number; samples: number } {
  const since = input.now - LOOKBACK_H * 3600_000;
  let spent = 0;
  let samples = 0;
  let earliest = Infinity;
  let latest = -Infinity;
  for (const sub of input.subs) {
    const points = sub.history.filter((h) => h.ts >= since && (h.five !== null || h.week !== null));
    if (points.length < 2) continue;
    samples += points.length;
    earliest = Math.min(earliest, points[0].ts);
    latest = Math.max(latest, points[points.length - 1].ts);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const d5 = a.five !== null && b.five !== null ? b.five - a.five : null;
      const d7 = a.week !== null && b.week !== null ? b.week - a.week : null;
      if (d5 !== null && d5 >= 0) spent += (d5 / 100) * sub.weight;
      else if (d7 !== null && d7 > 0) spent += (d7 / 100) * sub.weight * sub.weekWindows;
    }
  }
  const spanHours = latest > earliest ? (latest - earliest) / 3600_000 : 0;
  if (spanHours < MIN_SPAN_H) return { rate: 0, spanHours, samples };
  return { rate: spent / spanHours, spanHours, samples };
}

interface SimSub {
  weight: number;
  weekSize: number;
  left5: number;
  left7: number;
  /**
   * When each window turns over. Null for one that has not started — nothing spent in it, so no reset
   * time — which opens when it is first spent from. Infinity for one with usage but no known reset.
   */
  reset5: number | null;
  reset7: number | null;
  blockedUntil: number;
}

/**
 * A window with no reset time and nothing spent in it has not started: it opens on the first use and
 * turns over a window's length later. Read as "never resets", an idle subscription gave its first
 * five hours and then nothing for the rest of the forecast. One with usage but no reset time is
 * something nothing says will come back, and is left that way.
 */
function resetOf(w: UsageWindow | null): number | null {
  if (w?.resetsAt) return Date.parse(w.resetsAt);
  return w && w.pct > 0 ? Infinity : null;
}

function simState(input: BurnInput): SimSub[] {
  return input.subs.map((s) => {
    const [five, week] = ceilingsOf({ fiveHour: s.fiveHour, sevenDay: s.sevenDay }, s.weight, s.weekWindows);
    return {
      weight: s.weight,
      weekSize: week.size,
      left5: five.left,
      left7: week.left,
      reset5: resetOf(s.fiveHour),
      reset7: resetOf(s.sevenDay),
      blockedUntil: s.blockedUntil ?? 0,
    };
  });
}

function turnOver(s: SimSub, t: number): void {
  while (s.reset5 !== null && t >= s.reset5) {
    s.left5 = s.weight;
    s.reset5 += WINDOW_H.fiveHour * 3600_000;
  }
  while (s.reset7 !== null && t >= s.reset7) {
    s.left7 = s.weekSize;
    s.reset7 += WINDOW_H.sevenDay * 3600_000;
  }
}

/** Spend from a subscription, opening any window that had not started. The week-only forecast leaves the 5-hour window out. */
function draw(s: SimSub, amount: number, t: number, fiveHourToo = true): void {
  if (fiveHourToo) {
    s.left5 -= amount;
    s.reset5 ??= t + WINDOW_H.fiveHour * 3600_000;
  }
  s.left7 -= amount;
  s.reset7 ??= t + WINDOW_H.sevenDay * 3600_000;
}

const roomOfSim = (s: SimSub, t: number): number => (t < s.blockedUntil ? 0 : Math.min(s.left5, s.left7));

/**
 * When nothing on the desk has room, walked forward rather than divided, with both windows applied.
 *
 * Dividing headroom by rate answers a different question than the one asked: subscriptions reset at
 * their own times, and capacity coming back mid-afternoon is exactly what decides whether the desk
 * stops at all. So each subscription is carried forward with its own resets, spending is drawn from
 * whoever has the most room — which is what the swap logic actually does with it — and every unit
 * spent comes off both its windows. The answer is the first moment there is nothing anywhere, which
 * limit it was, and when something comes back.
 */
export function projectExhaustion(
  input: BurnInput,
  rate: number,
): { at: number; on: 'fiveHour' | 'sevenDay'; resumesAt: number | null } | null {
  if (rate < IDLE_RATE) return null;
  const live = simState(input);
  if (!live.length) return null;
  const stepMs = STEP_H * 3600_000;
  const horizon = input.now + HORIZON_H * 3600_000;
  for (let t = input.now; t < horizon; t += stepMs) {
    for (const s of live) turnOver(s, t);
    let owed = rate * STEP_H;
    while (owed > EPS) {
      const best = live.reduce((a, b) => (roomOfSim(b, t) > roomOfSim(a, t) ? b : a));
      const room = roomOfSim(best, t);
      if (room <= EPS) {
        // Stopped by the weeks when no subscription has any week left to give; otherwise by the
        // five-hour windows, which come back first.
        const weeksGone = live.every((s) => s.left7 <= EPS);
        const back = live
          .map((s) => Math.max(s.blockedUntil, (s.left7 <= EPS ? s.reset7 : s.left5 <= EPS ? s.reset5 : t) ?? Infinity))
          .filter((x) => Number.isFinite(x));
        return { at: t, on: weeksGone ? 'sevenDay' : 'fiveHour', resumesAt: back.length ? Math.min(...back) : null };
      }
      const take = Math.min(room, owed);
      draw(best, take, t);
      owed -= take;
    }
  }
  return null;
}

/** When the weeks alone are used up at this rate, whatever the five-hour windows allow. */
export function projectWeekExhaustion(input: BurnInput, rate: number): number | null {
  if (rate < IDLE_RATE) return null;
  const live = simState(input);
  if (!live.length) return null;
  const stepMs = STEP_H * 3600_000;
  const horizon = input.now + HORIZON_H * 3600_000;
  for (let t = input.now; t < horizon; t += stepMs) {
    for (const s of live) {
      while (s.reset7 !== null && t >= s.reset7) {
        s.left7 = s.weekSize;
        s.reset7 += WINDOW_H.sevenDay * 3600_000;
      }
    }
    let owed = rate * STEP_H;
    while (owed > EPS) {
      const best = live.reduce((a, b) => (b.left7 > a.left7 ? b : a));
      if (best.left7 <= EPS) return t;
      const take = Math.min(best.left7, owed);
      draw(best, take, t, false);
      owed -= take;
    }
  }
  return null;
}

export function forecast(input: BurnInput): BurnForecast {
  const { rate, spanHours, samples } = burnRate(input);
  const iso = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
  let capacity = 0;
  let nowLeft = 0;
  let weekCapacity = 0;
  let weekLeft = 0;
  let nextNow: number | null = null;
  let nextWeek: number | null = null;
  for (const s of simState(input)) {
    capacity += s.weight;
    weekCapacity += s.weekSize;
    weekLeft += s.left7;
    const blocked = s.blockedUntil > input.now;
    nowLeft += blocked ? 0 : Math.min(s.left5, s.left7);
    // Relief is the window holding a subscription back turning over, and only if it hands something back.
    const holding = blocked ? s.blockedUntil : s.left7 < s.left5 ? s.reset7 : s.reset5;
    const spentSome = s.left7 < s.left5 ? s.left7 < s.weekSize : s.left5 < s.weight;
    if ((blocked || spentSome) && holding !== null && Number.isFinite(holding)) nextNow = nextNow === null ? holding : Math.min(nextNow, holding);
    if (s.left7 < s.weekSize && s.reset7 !== null && Number.isFinite(s.reset7)) nextWeek = nextWeek === null ? s.reset7 : Math.min(nextWeek, s.reset7);
  }
  const stop = projectExhaustion(input, rate);
  const measured = input.subs.length > 0 && input.subs.every((s) => s.measured === true);
  return {
    rate,
    spanHours,
    samples,
    now: { capacity, remaining: nowLeft, nextResetAt: iso(nextNow) },
    week: { capacity: weekCapacity, remaining: weekLeft, nextResetAt: iso(nextWeek), exhaustedAt: iso(projectWeekExhaustion(input, rate)) },
    stopsAt: iso(stop?.at ?? null),
    stopsOn: stop?.on ?? null,
    resumesAt: iso(stop?.resumesAt ?? null),
    weekWindows: capacity > 0 ? weekCapacity / capacity : 0,
    weekWindowsMeasured: measured,
  };
}

/** Shape the daemon's stored samples the way the forecast wants them. */
export function pointsOf(history: UsagePoint[]): BurnSub['history'] {
  return history.map((h) => ({ ts: Date.parse(h.ts), five: h.fiveHourPct, week: h.sevenDayPct }));
}
