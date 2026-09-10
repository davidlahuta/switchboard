import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attentionFor, limitSwapPlan, rejectReservedArgs, safeToRespawn, titleDecision } from '../src/daemon/runs.ts';
import { readSessionModel } from '../src/daemon/transcript.ts';
import { headroomOf, SWAP_MARGIN, subscriptionScore, weightFor } from '../src/daemon/subscriptions.ts';
import type { Usage } from '../src/shared/types.ts';

const usage = (five: number | null, seven: number | null): Usage => ({
  fiveHour: five === null ? null : { pct: five, resetsAt: null },
  sevenDay: seven === null ? null : { pct: seven, resetsAt: null },
  scoped: [],
  fetchedAt: new Date().toISOString(),
  source: 'oauth',
  stale: false,
  error: null,
  errorKind: null,
  retryAt: null,
});

describe('when a session may be swapped', () => {
  it('swaps only a session known to be at a prompt', () => {
    assert.ok(safeToRespawn('idle'));
    assert.ok(safeToRespawn('limited'), 'the turn is already lost to the limit; swapping is the fix');
    assert.ok(safeToRespawn(undefined), 'no hooks ever ran, so nothing here can speak for it');
  });

  it('waits out anything that would cost a turn', () => {
    assert.ok(!safeToRespawn('working'));
    assert.ok(!safeToRespawn('waiting'), 'a permission prompt on screen goes with the process');
    assert.ok(!safeToRespawn('starting'));
    // An hour-long turn with no tool calls looks exactly like this once the sweep gives up on it.
    assert.ok(!safeToRespawn('offline'));
  });
});

describe('which sessions are asking to be looked at', () => {
  const t = (iso: string): string => new Date(iso).toISOString();
  const base = { agentStatus: 'idle' as const, lastActivity: t('2026-01-01T10:00:00Z'), lastViewedAt: t('2026-01-01T10:00:00Z'), unread: 0 };

  it('says nothing about a session that has done nothing since it was read', () => {
    const a = attentionFor(base);
    assert.deepEqual(a, { waiting: false, unread: 0, unseen: false });
  });

  it('marks a session stopped on a prompt only a person can clear', () => {
    assert.equal(attentionFor({ ...base, agentStatus: 'waiting' }).waiting, true);
  });

  it('marks a session that finished something after it was last read', () => {
    assert.equal(attentionFor({ ...base, lastActivity: t('2026-01-01T10:05:00Z') }).unseen, true);
  });

  it('leaves a session that is still working alone', () => {
    // It will finish on its own. A dot on everything busy is a dot worth nothing.
    const busy = attentionFor({ ...base, agentStatus: 'working', lastActivity: t('2026-01-01T10:05:00Z') });
    assert.equal(busy.unseen, false);
    assert.equal(busy.waiting, false);
  });

  it('marks a session that has never been opened', () => {
    assert.equal(attentionFor({ ...base, lastViewedAt: null }).unseen, true);
  });

  it('counts what a session addressed to the operator, whatever else it is doing', () => {
    assert.equal(attentionFor({ ...base, agentStatus: 'working', unread: 2 }).unread, 2);
  });
});

describe('moving a session off a spent subscription', () => {
  it('goes at once when the limit already ended the turn', () => {
    // StopFailure means claude stopped: there is no turn left to protect.
    const plan = limitSwapPlan('hook');
    assert.equal(plan.force, true);
    assert.equal(plan.deadline, null);
  });

  it('waits out the turn when the limit was only seen in the output', () => {
    // A subagent may have hit the limit while the parent works on, so the turn is still worth
    // something; it is given a bounded grace rather than being killed on the strength of some text.
    const now = Date.parse('2026-01-01T00:00:00Z');
    const plan = limitSwapPlan('pty', now);
    assert.equal(plan.force, false);
    assert.ok(plan.deadline! > now, 'queued behind the turn');
    assert.ok(plan.deadline! - now <= 5 * 60_000, 'but not indefinitely: the subscription is spent');
  });
});

describe('choosing where to put a session', () => {
  const base = { headroom: 0.5, fullHeadroom: 1, liveRuns: 0, priority: 0, resetsInMs: null, recentlyLeft: false };

  it('shares a subscription out among the sessions already on it', () => {
    // Two sessions burn it down about twice as fast, so it is worth about half as much to a third.
    const empty = subscriptionScore(base);
    const busy = subscriptionScore({ ...base, liveRuns: 2 });
    assert.ok(busy < empty);
    assert.ok(busy > 0);
  });

  it('spreads rather than piling onto the roomiest', () => {
    // A big plan with three sessions on it loses to an untouched smaller one.
    const crowded = subscriptionScore({ ...base, headroom: 1.0, liveRuns: 3 });
    const free = subscriptionScore({ ...base, headroom: 0.5, liveRuns: 0 });
    assert.ok(free > crowded);
  });

  it('counts a window that is about to turn over', () => {
    const spent = { ...base, headroom: 0.02, fullHeadroom: 1 };
    assert.ok(subscriptionScore({ ...spent, resetsInMs: 60_000 }) > subscriptionScore(spent), 'a minute away is nearly as good as reset');
    assert.equal(subscriptionScore({ ...spent, resetsInMs: 60 * 60_000 }), subscriptionScore(spent), 'an hour away counts for nothing');
  });

  it('avoids sending a session back where it just came from', () => {
    assert.ok(subscriptionScore({ ...base, recentlyLeft: true }) < subscriptionScore(base));
  });

  it('asks for a real improvement before moving a session at all', () => {
    // Marginally better is not worth a turn and a resume, and it only has to be moved back later.
    const staying = subscriptionScore(base);
    const marginal = subscriptionScore({ ...base, headroom: 0.55 });
    assert.ok(marginal < staying * SWAP_MARGIN, 'a tenth better does not justify a swap');
    const worthIt = subscriptionScore({ ...base, headroom: 0.9 });
    assert.ok(worthIt >= staying * SWAP_MARGIN, 'nearly twice the room does');
  });
});

describe('subscription headroom', () => {
  it('is capped by whichever window is tighter', () => {
    assert.equal(headroomOf(usage(10, 80), 20).headroom, 4);
    assert.equal(headroomOf(usage(10, 80), 20).bindingWindow, 'sevenDay');
    assert.equal(headroomOf(usage(90, 20), 20).bindingWindow, 'fiveHour');
  });

  it('weights by plan so a big plan at high usage can still beat a small idle one', () => {
    const max20 = headroomOf(usage(80, 10), weightFor('max', 'default_claude_max_20x')).headroom;
    const pro = headroomOf(usage(0, 0), weightFor('pro', null)).headroom;
    assert.ok(max20 > pro, `expected 20x at 80% (${max20}) to beat an unused Pro (${pro})`);
  });

  it('never goes negative and reports no binding window without data', () => {
    assert.equal(headroomOf(usage(100, 100), 5).headroom, 0);
    assert.equal(headroomOf(usage(null, null), 5).bindingWindow, null);
    assert.equal(headroomOf(null, 5).bindingWindow, null);
  });
});

describe('session name sync', () => {
  it('adopts a rename made inside the session', () => {
    assert.deepEqual(titleDecision('old', 'old', 'new'), { adopt: 'new' });
  });

  it('pushes a rename made in switchboard', () => {
    assert.deepEqual(titleDecision('new', 'old', 'old'), { push: 'new' });
  });

  it('does nothing once both sides agree', () => {
    assert.deepEqual(titleDecision('same', 'same', 'same'), {});
  });

  it('pushes when the session has no title yet', () => {
    assert.deepEqual(titleDecision('mine', null, null), { push: 'mine' });
  });

  it('settles rather than pushing forever when the session already has the name', () => {
    assert.deepEqual(titleDecision('mine', null, 'mine'), { adopt: 'mine' });
  });
});

describe('session model sync', () => {
  it('reads the newest model from a transcript, ignoring subagent turns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-transcript-'));
    const file = path.join(dir, 't.jsonl');
    try {
      fs.writeFileSync(
        file,
        [
          JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5' } }),
          JSON.stringify({ type: 'user', message: { content: 'hi' } }),
          JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'claude-fable-5-1' } }),
          JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5-20251001' } }),
          '',
        ].join('\n'),
      );
      assert.equal(readSessionModel(file), 'claude-fable-5-1');
      assert.equal(readSessionModel(path.join(dir, 'missing.jsonl')), null);
      // /model appends an attachment naming the new model before any turn has run on it.
      fs.appendFileSync(
        file,
        JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'model', identity: { modelId: 'claude-opus-5' } } }) + '\n',
      );
      assert.equal(readSessionModel(file), 'claude-opus-5', 'a /model record newer than the last turn wins');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('per-session claude arguments', () => {
  it('accepts ordinary arguments', () => {
    assert.doesNotThrow(() => rejectReservedArgs(['--permission-mode', 'auto', '--add-dir', '../shared']));
  });

  it('refuses arguments Switchboard owns, including the = form', () => {
    for (const bad of [['--resume', 'x'], ['--session-id', 'x'], ['--settings=foo.json'], ['--mcp-config', 'x'], ['-w', 'name'], ['--continue']]) {
      assert.throws(() => rejectReservedArgs(bad), /Switchboard manages/, `expected ${bad[0]} to be refused`);
    }
  });
});
