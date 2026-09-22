import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/daemon/db.ts';
import { rescueDecision } from '../src/daemon/runs.ts';
import { SPEND_CAP_MAX_MS, SubscriptionManager } from '../src/daemon/subscriptions.ts';
import type { Bus } from '../src/daemon/bus.ts';
import type { Launcher } from '../src/daemon/launcher.ts';

/*
 * Where a session stopped on a limit is sent, replayed on the figures of 22 September 12:07, when
 * "core alignment" and "launch specs" both stopped and were told there was nowhere to go. Both were
 * running Fable, and every subscription was spent for Fable: two had their Fable week at 100%, two
 * their five-hour window, two their week. Once switched to Opus, one moved within two minutes.
 */

const HOUR = 3600_000;
const FABLE = 'claude-fable-5-1';
const OPUS = 'claude-opus-5';
const at = (ms: number): string => new Date(ms).toISOString();

describe('where a session stopped on a limit goes', () => {
  const dirs: string[] = [];
  let db: Db;
  let subs: SubscriptionManager;
  let now: number;

  /** One logged-in Max 20x subscription with these windows (percent, and hours until each resets). */
  const sub = (
    id: string,
    five: [number, number],
    seven: [number, number],
    fable: [number, number],
  ): void => {
    const usage = {
      fiveHour: { pct: five[0], resetsAt: at(now + five[1] * HOUR) },
      sevenDay: { pct: seven[0], resetsAt: at(now + seven[1] * HOUR) },
      scoped: [{ label: 'Fable', pct: fable[0], resetsAt: at(now + fable[1] * HOUR) }],
      fetchedAt: at(now),
      source: 'oauth',
      stale: false,
      error: null,
      errorKind: null,
      retryAt: null,
    };
    db.run(
      `INSERT INTO subscriptions (id, label, kind, config_dir, email, plan, rate_tier, enabled, priority, status, usage_json, created_at, account_email)
       VALUES (?, ?, 'profile', ?, ?, 'max', 'default_claude_max_20x', 1, 0, 'ready', ?, ?, ?)`,
      id,
      `${id}@x`,
      path.join(os.tmpdir(), id),
      `${id}@x`,
      JSON.stringify(usage),
      at(now),
      `${id}@x`,
    );
  };

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-place-'));
    dirs.push(dir);
    db = new Db(path.join(dir, 'switchboard.db'));
    subs = new SubscriptionManager(db, { invalidate() {}, toast() {} } as unknown as Bus, {} as Launcher);
    now = Date.now();
    //       five-hour      seven-day      Fable week
    sub('info', [27, 5], [55, 90], [100, 130]);
    sub('hello', [100, 5.5], [27, 160], [53, 160]);
    sub('admin', [100, 5.4], [31, 150], [62, 150]);
    sub('david', [10, 4.7], [100, 85], [57, 85]);
    sub('sales', [0, 5], [100, 50], [21, 50]);
    sub('devops', [18, 5.2], [54, 135], [100, 135]);
  });

  afterEach(() => db.close());

  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('finds nowhere for a session on Fable when every subscription is spent for Fable', () => {
    assert.equal(subs.rank({ exclude: 'hello', atLimit: true, model: FABLE }), null);
    assert.equal(subs.rank({ exclude: 'info', atLimit: true, model: FABLE }), null);
  });

  it('and says when the first one has room again: the soonest a spent window turns over', () => {
    // From hello: admin's five-hour window, 5.4 hours out, beats every week that has to reset.
    assert.equal(subs.roomReturnsAt(FABLE, 'hello', now), Date.parse(at(now + 5.4 * HOUR)));
    // From info, hello's own five-hour window counts too, and admin's is still sooner.
    assert.equal(subs.roomReturnsAt(FABLE, 'info', now), Date.parse(at(now + 5.4 * HOUR)));
  });

  it('moves the same session at once when it runs another model', () => {
    // The Fable weeks spent on devops and info are nothing to Opus.
    assert.equal(subs.rank({ exclude: 'hello', atLimit: true, model: OPUS })?.row.id, 'devops');
    assert.equal(subs.rank({ exclude: 'devops', atLimit: true, model: OPUS })?.row.id, 'info');
  });

  it('puts a Fable session where the most of the Fable week is left, not where the account-wide week looks emptiest', () => {
    db.run("UPDATE subscriptions SET enabled = 0 WHERE id IN ('info', 'devops')");
    // Both five-hour windows open again. hello has more of its week left (73% to 69%), admin more of
    // its Fable week (47% to 38%): the account-wide numbers alone pick hello.
    const set = (id: string, fable: number): void => {
      const u = JSON.parse(db.get<{ usage_json: string }>('SELECT usage_json FROM subscriptions WHERE id = ?', id)!.usage_json);
      u.fiveHour.pct = 0;
      u.scoped[0].pct = fable;
      db.run('UPDATE subscriptions SET usage_json = ? WHERE id = ?', JSON.stringify(u), id);
    };
    set('hello', 62);
    set('admin', 53);
    assert.equal(subs.rank({ exclude: 'david', atLimit: true, model: FABLE })?.row.id, 'admin');
    assert.equal(subs.rank({ exclude: 'david', atLimit: true, model: OPUS })?.row.id, 'hello', 'and for Opus, the week decides');
  });

  describe('a spend cap', () => {
    it('makes the subscription spent, however much its windows have left', () => {
      // info hits its spend cap with 55% of its week and 27% of its five hours showing.
      subs.markSpendCapped('info', now);
      assert.equal(subs.usedPct('info', OPUS), 100);
      assert.notEqual(subs.rank({ exclude: 'devops', atLimit: true, model: OPUS })?.row.id, 'info');
      assert.equal(subs.rank({ exclude: 'devops', atLimit: true, model: OPUS }), null, 'devops was the only other one with room');
    });

    it('is not sent straight back to: the 11:57 cap on hello, and the 12:06 move back to it', () => {
      db.run("UPDATE subscriptions SET usage_json = json_set(usage_json, '$.fiveHour.pct', 86) WHERE id = 'hello'");
      db.run("UPDATE subscriptions SET enabled = 0 WHERE id IN ('info', 'devops')");
      assert.equal(subs.rank({ exclude: 'david', atLimit: true, model: FABLE })?.row.id, 'hello', 'by its numbers hello has room');
      subs.markSpendCapped('hello', now);
      assert.equal(subs.rank({ exclude: 'david', atLimit: true, model: FABLE }), null, 'but it has just refused a session');
    });

    it('lasts until the five-hour window turns over, and no longer than one window', () => {
      const until = subs.markSpendCapped('hello', now);
      assert.equal(until, now + SPEND_CAP_MAX_MS, 'hello resets in 5.5 hours: capped at one window');
      assert.equal(subs.markSpendCapped('info', now), Date.parse(at(now + 5 * HOUR)), 'info resets in 5');
      assert.equal(subs.spendCapped('hello', until - 1), until);
      assert.equal(subs.spendCapped('hello', until + 1), null);
    });

    it('is over as soon as a session there finishes a turn', () => {
      subs.markSpendCapped('info', now);
      subs.clearSpendCap('info');
      assert.equal(subs.spendCapped('info', now), null);
      assert.equal(subs.rank({ exclude: 'devops', atLimit: true, model: OPUS })?.row.id, 'info');
    });

    it('counts in when room comes back', () => {
      db.run("UPDATE subscriptions SET enabled = 0 WHERE id <> 'info'");
      subs.markSpendCapped('info', now);
      // info is spent for Fable until its Fable week resets, which is later than the cap lifts.
      assert.equal(subs.roomReturnsAt(FABLE, null, now), Date.parse(at(now + 130 * HOUR)));
      assert.equal(subs.roomReturnsAt(OPUS, null, now), subs.spendCapped('info', now));
    });

    it('keeps a session waiting on its own capped subscription from being told to carry on there', () => {
      subs.markSpendCapped('info', now);
      // Its windows say 55%: read alone, the rescue would tell it to carry on into the same cap.
      assert.equal(rescueDecision({ ownUsedPct: subs.usedPct('info', OPUS), bestElsewherePct: subs.usedPct('devops', OPUS), threshold: 90 }), 'move');
      assert.equal(rescueDecision({ ownUsedPct: subs.usedPct('info', OPUS), bestElsewherePct: null, threshold: 90 }), 'wait');
    });
  });
});
