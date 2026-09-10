import type { BurnForecast, BurnWindow, UsagePoint } from '../shared/types.ts';

/**
 * When the desk runs out of usage, at the rate it is spending now.
 *
 * The per-subscription numbers answer "where should this session go"; they do not answer the
 * question an operator actually asks at four in the afternoon, which is whether the whole desk is
 * about to stop. That one is about the pool: eight sessions spread across four subscriptions spend
 * one budget, and either it lasts until the windows turn over or it does not.
 *
 * Everything here is in **units of weight** — a 20x Max counts twenty times a Pro — because percent
 * is not addable across plans. A window at 50% on a 20x and a window at 50% on a Pro are not
 * "50% of the desk".
 */

/** Samples older than this say nothing about the rate right now. */
const LOOKBACK_H = 3;
/** Below this much measured time, a rate is noise. */
const MIN_SPAN_H = 0.5;
/** Rates under this are treated as nothing being spent at all, rather than as a very slow leak. */
const IDLE_RATE = 0.01;
/** How far ahead each window is simulated before the answer is "never". */
const HORIZON_H = { fiveHour: 24, sevenDay: 14 * 24 } as const;
/** How long each window is, and so how long after a reset the next one comes. */
export const WINDOW_H = { fiveHour: 5, sevenDay: 7 * 24 } as const;
/** Simulation step. Fine enough to land a forecast on the right ten minutes. */
const STEP_H = 1 / 12;

export interface BurnInput {
  /** enabled, ready subscriptions only: anything else cannot absorb a session */
  subs: Array<{
    id: string;
    weight: number;
    /** 0–100, or null when nothing has reported */
    pct: number | null;
    /** ISO, or null when the window has not started */
    resetsAt: string | null;
    /** oldest first */
    history: Array<{ ts: number; pct: number | null }>;
  }>;
  window: 'fiveHour' | 'sevenDay';
  now: number;
}

/**
 * How fast the pool is being spent, in units per hour.
 *
 * Measured from the samples rather than from anything Claude Code reports, because nothing reports
 * it. Each subscription's own percentage is differenced and scaled by its weight; a drop means the
 * window turned over rather than that usage was handed back, so falls are ignored and only the
 * climbs are added up.
 */
export function burnRate(input: BurnInput): { rate: number; spanHours: number; samples: number } {
  const since = input.now - LOOKBACK_H * 3600_000;
  let spent = 0;
  let samples = 0;
  let earliest = Infinity;
  let latest = -Infinity;
  for (const sub of input.subs) {
    const points = sub.history.filter((h) => h.ts >= since && h.pct !== null);
    if (points.length < 2) continue;
    samples += points.length;
    earliest = Math.min(earliest, points[0].ts);
    latest = Math.max(latest, points[points.length - 1].ts);
    for (let i = 1; i < points.length; i++) {
      const delta = (points[i].pct as number) - (points[i - 1].pct as number);
      if (delta > 0) spent += (delta / 100) * sub.weight;
    }
  }
  const spanHours = latest > earliest ? (latest - earliest) / 3600_000 : 0;
  if (spanHours < MIN_SPAN_H) return { rate: 0, spanHours, samples };
  return { rate: spent / spanHours, spanHours, samples };
}

/**
 * When the pool empties, walked forward rather than divided.
 *
 * Dividing headroom by rate answers a different question than the one asked: subscriptions reset at
 * their own times, and capacity coming back mid-afternoon is exactly what decides whether the desk
 * stops at all. So each subscription is carried forward with its own reset, spending is drawn from
 * whoever has the most left — which is what the swap logic actually does with it — and the answer is
 * the first moment there is nothing anywhere. Reaching the horizon with usage still available is
 * "never": at this rate the windows hand capacity back faster than the desk can spend it.
 */
export function projectExhaustion(input: BurnInput, rate: number): number | null {
  if (rate < IDLE_RATE) return null;
  const windowMs = WINDOW_H[input.window] * 3600_000;
  const live = input.subs.map((s) => ({
    weight: s.weight,
    left: (s.weight * (100 - (s.pct ?? 0))) / 100,
    // A window with no reset time behaves as one that never resets: nothing says it will.
    resetsAt: s.resetsAt ? Date.parse(s.resetsAt) : Infinity,
  }));
  if (!live.length) return null;
  const stepMs = STEP_H * 3600_000;
  const horizon = input.now + HORIZON_H[input.window] * 3600_000;
  for (let t = input.now; t < horizon; t += stepMs) {
    for (const s of live) {
      while (t >= s.resetsAt) {
        s.left = s.weight;
        s.resetsAt += windowMs;
      }
    }
    let owed = rate * STEP_H;
    // Spend from whoever has the most room, the way a swap would place the sessions doing it.
    while (owed > 0) {
      const best = live.reduce((a, b) => (b.left > a.left ? b : a));
      if (best.left <= 0) return t;
      const take = Math.min(best.left, owed);
      best.left -= take;
      owed -= take;
    }
  }
  return null;
}

export function forecastWindow(input: BurnInput): BurnWindow {
  const { rate, spanHours, samples } = burnRate(input);
  let capacity = 0;
  let remaining = 0;
  let nextReset: number | null = null;
  for (const sub of input.subs) {
    capacity += sub.weight;
    remaining += (sub.weight * (100 - (sub.pct ?? 0))) / 100;
    const at = sub.resetsAt ? Date.parse(sub.resetsAt) : null;
    // Only a window with something to hand back is worth counting as relief.
    if (at !== null && (sub.pct ?? 0) > 0 && (nextReset === null || at < nextReset)) nextReset = at;
  }
  const exhausted = projectExhaustion(input, rate);
  return {
    capacity,
    remaining,
    rate,
    exhaustedAt: exhausted === null ? null : new Date(exhausted).toISOString(),
    nextResetAt: nextReset === null ? null : new Date(nextReset).toISOString(),
    spanHours,
    samples,
  };
}

/**
 * Both windows. They are given separately because a subscription's two windows are two different
 * numbers with two different reset times, and either of them stopping the desk stops it.
 */
export function forecast(fiveHour: BurnInput['subs'], sevenDay: BurnInput['subs'], now = Date.now()): BurnForecast {
  return {
    fiveHour: forecastWindow({ subs: fiveHour, window: 'fiveHour', now }),
    sevenDay: forecastWindow({ subs: sevenDay, window: 'sevenDay', now }),
  };
}

/** Shape the daemon's stored samples the way the forecast wants them, per window. */
export function pointsFor(history: UsagePoint[], window: 'fiveHour' | 'sevenDay'): Array<{ ts: number; pct: number | null }> {
  return history.map((h) => ({ ts: Date.parse(h.ts), pct: window === 'fiveHour' ? h.fiveHourPct : h.sevenDayPct }));
}
