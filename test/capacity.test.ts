import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bindingText, DEFAULT_WEEK_WINDOWS, isSpent, roomOf, weekWindowsFrom, WEEK_WINDOWS_MAX } from '../src/shared/capacity.ts';
import type { Usage } from '../src/shared/types.ts';

const R = 4.2;
const close = (a: number, b: number, msg?: string): void => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} ≠ ${b}`);
const windows = (five: number | null, week: number | null, scoped: Usage['scoped'] = []) => ({
  fiveHour: five === null ? null : { pct: five, resetsAt: '2026-01-01T15:00:00Z' },
  sevenDay: week === null ? null : { pct: week, resetsAt: '2026-01-05T00:00:00Z' },
  scoped,
});

describe('room under every limit, in one unit', () => {
  it('counts a point of the week as several points of the 5-hour window', () => {
    // devops at 16:50 on 24 September: 84% of its 5-hour window left, 13% of its week.
    const room = roomOf(windows(16, 87), 20, R);
    close(room.now, 20 * R * 0.13, 'the week binds, but with over half a 5-hour window in it — not 13% of one');
    assert.equal(room.binding?.kind, 'sevenDay');
    close(room.usedPct, 100 * (1 - (R * 0.13)), 'the threshold sees about 45% of a window gone');
  });

  it('moves a session off a week that is really running out, not off one at 90%', () => {
    // What the proactive threshold (90) compares against.
    close(roomOf(windows(0, 90), 20, R).usedPct, 100 * (1 - 0.42), 'a week at 90% still holds 0.42 of a window');
    assert.ok(roomOf(windows(0, 90), 20, R).usedPct < 90);
    assert.ok(roomOf(windows(0, 98), 20, R).usedPct >= 90, 'at 98% less than a tenth of a window is left');
  });

  it('lets the 5-hour window bind when the week has plenty behind it', () => {
    const room = roomOf(windows(80, 60), 20, R);
    close(room.now, 4);
    assert.equal(room.binding?.kind, 'fiveHour');
    close(room.week, 20 * R * 0.4);
    close(room.afterReset, 20, 'a whole window once the 5-hour one turns over, the week having more than that');
  });

  it('gives nothing for a fresh 5-hour window on a spent week', () => {
    const room = roomOf(windows(0, 100), 20, R);
    assert.equal(room.now, 0);
    assert.equal(room.usedPct, 100);
    assert.ok(isSpent(room.binding!, 20));
  });

  it('comes back no further than the week allows once the 5-hour window turns over', () => {
    // Out of 5-hour window, with a quarter of a window left in the week.
    const room = roomOf(windows(100, 100 - 25 / R), 20, R);
    assert.equal(room.binding?.kind, 'fiveHour');
    close(room.afterReset, 5);
  });

  it('holds a session on a model to that model’s week, sized like the account’s', () => {
    const u = windows(5, 30, [{ label: 'Fable', pct: 90, resetsAt: null }]);
    close(roomOf(u, 20, R, 'claude-fable-5-1').now, 20 * R * 0.1);
    assert.equal(roomOf(u, 20, R, 'claude-fable-5-1').binding?.kind, 'scoped');
    close(roomOf(u, 20, R, 'claude-opus-5-5').now, 19, 'another model is not held to it');
  });

  it('assumes a window that has not reported is part spent, and says nothing binds', () => {
    const room = roomOf(null, 20, R);
    close(room.now, 12, '40% assumed of the 5-hour window');
    assert.equal(room.binding, null);
  });

  it('says in words which limit it is and how much is under it', () => {
    assert.equal(bindingText(roomOf(windows(50, 10), 20, R), 20), '50% of its 5-hour window left');
    assert.equal(bindingText(roomOf(windows(16, 87), 20, R), 20), 'its week has 0.5 of a five-hour window left (87% used)');
    assert.equal(bindingText(roomOf(windows(0, 50), 20, R), 20), 'a whole 5-hour window left');
    assert.equal(bindingText(roomOf(windows(0, 100), 20, R), 20), 'its week is spent');
    assert.equal(bindingText(roomOf(windows(100, 20), 20, R), 20), 'its 5-hour window is spent');
    const fable = windows(5, 30, [{ label: 'Fable', pct: 95, resetsAt: null }]);
    assert.equal(bindingText(roomOf(fable, 20, R, 'claude-fable-5-1'), 20), 'its Fable week has 0.2 of a five-hour window left (95% used)');
  });
});

describe('how many 5-hour windows a week holds', () => {
  const series = (ratio: number, steps: number, noise = 0) => {
    const out: Array<{ ts: number; five: number | null; week: number | null }> = [];
    let five = 0;
    let week = 0;
    for (let i = 0; i < steps; i++) {
      out.push({ ts: i * 5 * 60_000, five: Math.round(five), week: Math.round(week) });
      const spent = 2 + (i % 3) * noise;
      five += spent;
      week += spent / ratio;
      if (five > 100) five = 0; // the 5-hour window turning over
    }
    return out;
  };

  it('reads it from how the two climb together, through the one-point steps they are reported in', () => {
    const v = weekWindowsFrom(series(4.2, 2000, 1));
    assert.ok(v !== null && Math.abs(v - 4.2) < 0.15, `expected about 4.2, got ${v}`);
  });

  it('leaves out turnovers and gaps rather than reading them as climbs', () => {
    const s = series(4.2, 2000);
    // A long gap in which the week climbed a lot and the 5-hour window turned over unseen.
    s.splice(1000, 0, { ts: s[999].ts + 60_000 * 60 * 6, five: 3, week: (s[999].week ?? 0) + 30 });
    for (let i = 1001; i < s.length; i++) s[i].ts += 60_000 * 60 * 6;
    const v = weekWindowsFrom(s);
    assert.ok(v !== null && Math.abs(v - 4.2) < 0.2, `expected about 4.2, got ${v}`);
  });

  it('will not guess from too little', () => {
    assert.equal(weekWindowsFrom(series(4.2, 20)), null);
  });

  it('keeps an impossible measurement inside what a week can hold', () => {
    const v = weekWindowsFrom(series(80, 4000));
    assert.equal(v, WEEK_WINDOWS_MAX);
    assert.ok(DEFAULT_WEEK_WINDOWS > 1 && DEFAULT_WEEK_WINDOWS < WEEK_WINDOWS_MAX);
  });
});
