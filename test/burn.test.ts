import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { burnRate, forecastWindow, projectExhaustion, type BurnInput } from '../src/daemon/burn.ts';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const H = 3600_000;

/** Samples every five minutes, climbing at a steady pct/hour. */
function climb(fromPct: number, pctPerHour: number, hours: number): Array<{ ts: number; pct: number | null }> {
  const out: Array<{ ts: number; pct: number | null }> = [];
  for (let m = hours * 60; m >= 0; m -= 5) {
    out.push({ ts: NOW - m * 60_000, pct: fromPct + ((hours * 60 - m) / 60) * pctPerHour });
  }
  return out;
}

describe('how fast the desk is spending', () => {
  it('adds up what every subscription spent, weighted by what a point of it is worth', () => {
    // A 20x climbing 10 pct/h spends 2 units/h; a Pro climbing the same spends 0.1.
    const input: BurnInput = {
      window: 'fiveHour',
      now: NOW,
      subs: [
        { id: 'max', weight: 20, pct: 30, resetsAt: null, history: climb(20, 10, 2) },
        { id: 'pro', weight: 1, pct: 30, resetsAt: null, history: climb(20, 10, 2) },
      ],
    };
    assert.ok(Math.abs(burnRate(input).rate - 2.1) < 0.05, `expected about 2.1 units/h, got ${burnRate(input).rate}`);
  });

  it('reads a window turning over as capacity handed back, not as spending', () => {
    // 80 → 5 is a reset. Counting the fall would report a negative rate; counting its size as spend
    // would report a wild one. Only the climbs on either side are real.
    const history = [
      { ts: NOW - 2 * H, pct: 70 },
      { ts: NOW - 1.5 * H, pct: 80 },
      { ts: NOW - 1 * H, pct: 5 },
      { ts: NOW - 0.5 * H, pct: 15 },
    ];
    const rate = burnRate({ window: 'fiveHour', now: NOW, subs: [{ id: 'a', weight: 10, pct: 15, resetsAt: null, history }] }).rate;
    assert.ok(rate > 0, 'the climbs still count');
    assert.ok(rate < 2, `a reset must not read as a spike, got ${rate}`);
  });

  it('refuses to guess from a handful of minutes', () => {
    const history = [
      { ts: NOW - 5 * 60_000, pct: 10 },
      { ts: NOW, pct: 40 },
    ];
    const { rate, spanHours } = burnRate({ window: 'fiveHour', now: NOW, subs: [{ id: 'a', weight: 10, pct: 40, resetsAt: null, history }] });
    assert.equal(rate, 0, 'five minutes of samples is noise, not a rate');
    assert.ok(spanHours < 0.5);
  });
});

describe('when the desk has to stop', () => {
  const sub = (over: Partial<BurnInput['subs'][number]> = {}): BurnInput['subs'][number] => ({
    id: 'a',
    weight: 10,
    pct: 50,
    resetsAt: null,
    history: [],
    ...over,
  });

  it('says never when nothing is being spent', () => {
    assert.equal(projectExhaustion({ window: 'fiveHour', now: NOW, subs: [sub()] }, 0), null);
  });

  it('lands on the hour the pool empties', () => {
    // 5 units left, 1 unit an hour, nothing resetting: five hours.
    const at = projectExhaustion({ window: 'fiveHour', now: NOW, subs: [sub({ weight: 10, pct: 50 })] }, 1);
    assert.ok(at !== null);
    assert.ok(Math.abs(at - (NOW + 5 * H)) < 0.2 * H, `expected about five hours, got ${(at - NOW) / H}h`);
  });

  it('says never when the window turns over before the pool runs dry', () => {
    // Spending a unit an hour with 5 left would empty in five hours — but the whole 10 comes back in
    // one, and every five hours after that. This is the answer the panel exists to give.
    const at = projectExhaustion(
      { window: 'fiveHour', now: NOW, subs: [sub({ weight: 10, pct: 50, resetsAt: new Date(NOW + 1 * H).toISOString() })] },
      1,
    );
    assert.equal(at, null);
  });

  it('still stops when the reset cannot keep up with the spending', () => {
    // 10 units every five hours is 2 units an hour of income against 6 an hour of spend.
    const at = projectExhaustion(
      { window: 'fiveHour', now: NOW, subs: [sub({ weight: 10, pct: 50, resetsAt: new Date(NOW + 1 * H).toISOString() })] },
      6,
    );
    assert.ok(at !== null && at > NOW, 'it runs out, just later than it would have without the reset');
  });

  it('pools across subscriptions rather than stopping at the first empty one', () => {
    const at = projectExhaustion(
      {
        window: 'fiveHour',
        now: NOW,
        subs: [sub({ id: 'spent', weight: 10, pct: 100 }), sub({ id: 'fresh', weight: 10, pct: 0 })],
      },
      1,
    );
    assert.ok(at !== null);
    assert.ok(Math.abs(at - (NOW + 10 * H)) < 0.3 * H, 'the empty one contributes nothing, the fresh one carries it');
  });
});

describe('the forecast the overview shows', () => {
  it('reports the pool, not the percentages', () => {
    const w = forecastWindow({
      window: 'fiveHour',
      now: NOW,
      subs: [
        { id: 'max', weight: 20, pct: 50, resetsAt: new Date(NOW + 2 * H).toISOString(), history: [] },
        { id: 'pro', weight: 1, pct: 0, resetsAt: null, history: [] },
      ],
    });
    assert.equal(w.capacity, 21);
    assert.equal(w.remaining, 11, 'half of the 20x plus all of the Pro');
    assert.equal(w.nextResetAt, new Date(NOW + 2 * H).toISOString(), 'the one with something to hand back');
  });

  it('says it has nothing to go on rather than inventing a rate', () => {
    const w = forecastWindow({ window: 'sevenDay', now: NOW, subs: [{ id: 'a', weight: 5, pct: 10, resetsAt: null, history: [] }] });
    assert.equal(w.rate, 0);
    assert.equal(w.samples, 0);
    assert.equal(w.exhaustedAt, null);
  });
});
