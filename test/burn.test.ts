import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { burnRate, forecast, projectExhaustion, projectWeekExhaustion, type BurnInput, type BurnSub } from '../src/daemon/burn.ts';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const H = 3600_000;
const R = 4.2;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Samples every five minutes, the 5-hour window climbing at a steady pct/hour and the week with it. */
function climb(fromPct: number, pctPerHour: number, hours: number): BurnSub['history'] {
  const out: BurnSub['history'] = [];
  for (let m = hours * 60; m >= 0; m -= 5) {
    const five = fromPct + ((hours * 60 - m) / 60) * pctPerHour;
    out.push({ ts: NOW - m * 60_000, five, week: 10 + (five - fromPct) / R });
  }
  return out;
}

const sub = (over: Partial<BurnSub> = {}): BurnSub => ({
  id: 'a',
  weight: 10,
  weekWindows: R,
  fiveHour: { pct: 50, resetsAt: null },
  sevenDay: { pct: 0, resetsAt: null },
  history: [],
  ...over,
});

describe('how fast the desk is spending', () => {
  it('adds up what every subscription spent, weighted by what a point of it is worth', () => {
    // A 20x climbing 10 pct/h of its 5-hour window spends 2 units/h; a Pro climbing the same spends 0.1.
    const input: BurnInput = {
      now: NOW,
      subs: [sub({ id: 'max', weight: 20, history: climb(20, 10, 2) }), sub({ id: 'pro', weight: 1, history: climb(20, 10, 2) })],
    };
    assert.ok(Math.abs(burnRate(input).rate - 2.1) < 0.05, `expected about 2.1 units/h, got ${burnRate(input).rate}`);
  });

  it('keeps counting across a 5-hour turnover, from the week', () => {
    // 80 → 5 is the 5-hour window turning over; the week kept climbing through it, 2.4 points a half
    // hour, which on a 4.2-window week is the same 1 unit a half hour the 5-hour climbs show.
    const history = [
      { ts: NOW - 1.5 * H, five: 70, week: 20 },
      { ts: NOW - 1 * H, five: 80, week: 22.4 },
      { ts: NOW - 0.5 * H, five: 5, week: 24.8 },
      { ts: NOW, five: 15, week: 27.2 },
    ];
    const rate = burnRate({ now: NOW, subs: [sub({ history })] }).rate;
    assert.ok(Math.abs(rate - 2) < 0.05, `the turnover neither spikes nor drops the rate, got ${rate}`);
  });

  it('refuses to guess from a handful of minutes', () => {
    const history = [
      { ts: NOW - 5 * 60_000, five: 10, week: 1 },
      { ts: NOW, five: 40, week: 8 },
    ];
    const { rate, spanHours } = burnRate({ now: NOW, subs: [sub({ history })] });
    assert.equal(rate, 0, 'five minutes of samples is noise, not a rate');
    assert.ok(spanHours < 0.5);
  });
});

describe('when the desk has to stop', () => {
  it('says never when nothing is being spent', () => {
    assert.equal(projectExhaustion({ now: NOW, subs: [sub()] }, 0), null);
  });

  it('lands on the hour the room runs out', () => {
    // 5 units left in the 5-hour window, a week behind it, 1 unit an hour, nothing resetting: five hours.
    const stop = projectExhaustion({ now: NOW, subs: [sub()] }, 1);
    assert.ok(stop);
    assert.ok(Math.abs(stop.at - (NOW + 5 * H)) < 0.2 * H, `expected about five hours, got ${(stop.at - NOW) / H}h`);
    assert.equal(stop.on, 'fiveHour');
  });

  it('says never when both windows hand room back faster than it is spent', () => {
    // 10 units every five hours, and a 42-unit week every 168 hours, against 0.2 an hour.
    const subs = [sub({ fiveHour: { pct: 50, resetsAt: iso(NOW + H) }, sevenDay: { pct: 0, resetsAt: iso(NOW + 24 * H) } })];
    assert.equal(projectExhaustion({ now: NOW, subs }, 0.2), null);
  });

  it('still stops when the week cannot keep up, though every 5-hour window could', () => {
    // 1 an hour is 168 a week against a 42-unit week: out 42 hours after the weekly reset.
    const subs = [sub({ fiveHour: { pct: 50, resetsAt: iso(NOW + H) }, sevenDay: { pct: 0, resetsAt: iso(NOW + 24 * H) } })];
    const stop = projectExhaustion({ now: NOW, subs }, 1);
    assert.ok(stop);
    assert.equal(stop.on, 'sevenDay');
    assert.ok(Math.abs(stop.at - (NOW + 66 * H)) < 0.2 * H, `expected about 66 hours, got ${(stop.at - NOW) / H}h`);
  });

  it('does not refill a 5-hour window whose week is spent', () => {
    // The mistake this replaced: "fresh" has an empty 5-hour window and nothing left of its week, so
    // it contributes nothing, and the desk stops when "busy" runs out — not ten units later.
    const stop = projectExhaustion(
      {
        now: NOW,
        subs: [
          sub({ id: 'fresh', fiveHour: { pct: 0, resetsAt: null }, sevenDay: { pct: 100, resetsAt: iso(NOW + 72 * H) } }),
          sub({ id: 'busy', fiveHour: { pct: 50, resetsAt: null }, sevenDay: { pct: 0, resetsAt: null } }),
        ],
      },
      1,
    );
    assert.ok(stop);
    assert.ok(Math.abs(stop.at - (NOW + 5 * H)) < 0.2 * H, `expected about five hours, got ${(stop.at - NOW) / H}h`);
    assert.equal(stop.resumesAt, NOW + 72 * H, 'room comes back when the spent week turns over');
  });

  it('stops on the weeks when the 5-hour windows could keep going', () => {
    // A 5-hour window turning over every hour, but only 4.2 units of week left.
    const stop = projectExhaustion(
      { now: NOW, subs: [sub({ fiveHour: { pct: 0, resetsAt: iso(NOW + H) }, sevenDay: { pct: 90, resetsAt: iso(NOW + 48 * H) } })] },
      1,
    );
    assert.ok(stop);
    assert.equal(stop.on, 'sevenDay');
    assert.ok(Math.abs(stop.at - (NOW + 4.2 * H)) < 0.2 * H, `expected about 4.2 hours, got ${(stop.at - NOW) / H}h`);
    assert.equal(stop.resumesAt, NOW + 48 * H);
  });

  it('opens a window nobody has used yet, and brings it back five hours later', () => {
    // An idle subscription: no reset time because nothing has been spent. Read as "never resets", it
    // gave ten units and then nothing; it gives ten every five hours until its week runs out.
    const subs = [sub({ fiveHour: { pct: 0, resetsAt: null }, sevenDay: { pct: 0, resetsAt: iso(NOW + 24 * H) } })];
    const stop = projectExhaustion({ now: NOW, subs }, 1);
    assert.ok(stop);
    assert.equal(stop.on, 'sevenDay');
    assert.ok(Math.abs(stop.at - (NOW + 66 * H)) < 0.2 * H, `expected about 66 hours, got ${(stop.at - NOW) / H}h`);
  });

  it('pools across subscriptions rather than stopping at the first empty one', () => {
    const later = iso(NOW + 100 * H);
    const stop = projectExhaustion(
      {
        now: NOW,
        subs: [sub({ id: 'spent', fiveHour: { pct: 100, resetsAt: later } }), sub({ id: 'fresh', fiveHour: { pct: 0, resetsAt: later } })],
      },
      1,
    );
    assert.ok(stop);
    assert.ok(Math.abs(stop.at - (NOW + 10 * H)) < 0.3 * H, 'the empty one contributes nothing, the fresh one carries it');
  });

  it('leaves a spend-capped subscription out until its cap lapses', () => {
    const stop = projectExhaustion({ now: NOW, subs: [sub({ blockedUntil: NOW + 3 * H })] }, 1);
    assert.ok(stop);
    assert.equal(stop.at, NOW, 'nothing to spend from the start');
    assert.equal(stop.resumesAt, NOW + 3 * H);
  });

  it('says when the weeks alone run out, whatever the 5-hour windows allow', () => {
    // 21 units of week at 1 an hour.
    const at = projectWeekExhaustion({ now: NOW, subs: [sub({ sevenDay: { pct: 50, resetsAt: null } })] }, 1);
    assert.ok(at !== null && Math.abs(at - (NOW + 21 * H)) < 0.2 * H, `expected about 21 hours, got ${at === null ? null : (at - NOW) / H}h`);
  });
});

describe('the forecast the overview shows', () => {
  it('reports what can be used now and what is left of the week, in units', () => {
    const f = forecast({
      now: NOW,
      subs: [
        // Half its 5-hour window, but only 10% of a 4.2-window week: 4.2 units, week-bound.
        sub({ id: 'max', weight: 20, fiveHour: { pct: 50, resetsAt: iso(NOW + 2 * H) }, sevenDay: { pct: 95, resetsAt: iso(NOW + 30 * H) }, measured: true }),
        sub({ id: 'pro', weight: 1, fiveHour: { pct: 0, resetsAt: null }, sevenDay: { pct: 0, resetsAt: null }, measured: true }),
      ],
    });
    assert.equal(f.now.capacity, 21);
    assert.ok(Math.abs(f.now.remaining - (4.2 + 1)) < 1e-9, `the week caps the 20x; got ${f.now.remaining}`);
    assert.ok(Math.abs(f.week.capacity - 21 * R) < 1e-9);
    assert.ok(Math.abs(f.week.remaining - (20 * R * 0.05 + R)) < 1e-9);
    assert.equal(f.now.nextResetAt, iso(NOW + 30 * H), 'what holds the 20x back is its week, not its 5-hour window');
    assert.ok(Math.abs(f.weekWindows - R) < 1e-9);
    assert.equal(f.weekWindowsMeasured, true);
  });

  it('says it has nothing to go on rather than inventing a rate', () => {
    const f = forecast({ now: NOW, subs: [sub()] });
    assert.equal(f.rate, 0);
    assert.equal(f.samples, 0);
    assert.equal(f.stopsAt, null);
    assert.equal(f.weekWindowsMeasured, false);
  });
});
