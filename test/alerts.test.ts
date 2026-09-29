import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DONE_SETTLE_MS, IN_USE_IDLE_MS, isDone, NEEDS_YOU_SETTLE_MS, needsYou, Presence, PRESENCE_STALE_MS, questionOnScreen, SessionAlerts } from '../src/daemon/alerts.ts';
import type { PushMessage } from '../src/daemon/push.ts';
import type { Run, SessionWork } from '../src/shared/types.ts';

const run = (over: Partial<Run> = {}): Run =>
  ({
    id: 'r1',
    name: 'spec-0213',
    status: 'running',
    agentStatus: 'idle',
    work: [],
    waiting: null,
    stalled: null,
    attention: { waiting: false, unread: 0, unseen: false },
    ...over,
  }) as Run;
const work = (kind: SessionWork['kind']): SessionWork[] => [{ id: kind, kind, label: null, since: '', lastSeen: '' }];

/** A desk whose one session goes through the states given, one per tick. */
function desk() {
  let current = run();
  const sent: PushMessage[] = [];
  const alerts = new SessionAlerts(
    { runs: () => [current], question: () => 'Which spec should I take next?', lastWords: () => 'PR #841 is merged and deployed.' },
    { send: async (m) => (sent.push(m), 1) },
  );
  let t = 1_000_000;
  const at = (state: Partial<Run>, advance = 0) => {
    t += advance;
    current = run(state);
    alerts.tick(t);
  };
  return { sent, at };
}

describe('when a session is done', () => {
  it('counts only a session with nothing of its own going or booked', () => {
    assert.ok(isDone(run()));
    assert.ok(!isDone(run({ agentStatus: 'working' })));
    for (const k of ['subagent', 'workflow', 'shell', 'monitor', 'wakeup', 'cron'] as const) assert.ok(!isDone(run({ work: work(k) })), k);
    assert.ok(!isDone(run({ status: 'swapping' })), 'about to come back');
    assert.ok(!isDone(run({ waiting: { kind: 'restart' } as never })), 'a restart is queued for it');
  });

  it('is told once, after a minute at rest, with what the session said last', () => {
    const d = desk();
    d.at({ agentStatus: 'working' });
    d.at({}, 1000);
    d.at({}, DONE_SETTLE_MS - 1000);
    assert.equal(d.sent.length, 0, 'not before it has settled');
    d.at({}, 1000);
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0]!.title, 'spec-0213 is done');
    assert.equal(d.sent[0]!.body, 'PR #841 is merged and deployed.');
    assert.equal(d.sent[0]!.url, '/#/sessions/r1');
    d.at({}, DONE_SETTLE_MS * 5);
    assert.equal(d.sent.length, 1, 'not again while it stays done');
  });

  it('is not told when a subagent ends and the session wakes to read it', () => {
    const d = desk();
    d.at({ agentStatus: 'working' });
    d.at({ work: work('subagent') }, 1000);
    d.at({}, 1000);
    d.at({ agentStatus: 'working' }, 5000);
    d.at({}, DONE_SETTLE_MS - 1000);
    assert.equal(d.sent.length, 0);
  });

  it('is not told about a session that has been idle since it opened, or was done before the daemon started', () => {
    const fresh = desk();
    fresh.at({});
    fresh.at({}, DONE_SETTLE_MS * 2);
    assert.equal(fresh.sent.length, 0);
    const opened = desk();
    opened.at({ agentStatus: 'starting' });
    opened.at({}, 1000);
    opened.at({}, DONE_SETTLE_MS * 2);
    assert.equal(opened.sent.length, 0, 'starting is not work');
  });
});

describe('when a session needs you', () => {
  it('counts a question, a permission, and a session that has stopped retrying', () => {
    assert.ok(needsYou(run({ agentStatus: 'waiting', attention: { waiting: true, unread: 0, unseen: false } })));
    assert.ok(needsYou(run({ stalled: { reason: 'an API error', since: '', nextTry: null, tries: 5 } })));
    assert.ok(!needsYou(run({ stalled: { reason: 'an API error', since: '', nextTry: 'soon', tries: 1 } })), 'still retrying on its own');
  });

  it('is told once the question has stayed, with the question, and again after it was answered', () => {
    const d = desk();
    const asking = { agentStatus: 'waiting' as const, attention: { waiting: true, unread: 0, unseen: false } };
    d.at({ agentStatus: 'working' });
    d.at(asking, 1000);
    assert.equal(d.sent.length, 0, 'a prompt answered at once is not worth a notification');
    d.at(asking, NEEDS_YOU_SETTLE_MS);
    assert.equal(d.sent.length, 1);
    assert.equal(d.sent[0]!.kind, 'needsYou');
    assert.equal(d.sent[0]!.body, 'Which spec should I take next?');
    d.at(asking, 60_000);
    assert.equal(d.sent.length, 1);
    d.at({ agentStatus: 'working' }, 1000);
    d.at(asking, 1000);
    d.at(asking, NEEDS_YOU_SETTLE_MS);
    assert.equal(d.sent.length, 2);
  });
});

describe('the question on a session screen', () => {
  it('reads the line above the options', () => {
    const screen = [
      '● I have two candidates.',
      ' Which spec should I take next?',
      '❯ 1. 0442 mailing',
      '  2. 0459 certificates',
      '  3. Type something.',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    assert.equal(questionOnScreen(screen), 'Which spec should I take next?');
  });

  it('reads a permission prompt, and nothing from a screen with no question', () => {
    assert.equal(questionOnScreen('Bash command\n  rm -rf dist\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel'), 'Do you want to proceed?');
    assert.equal(questionOnScreen('● done\n❯ \n  ⏵⏵ bypass permissions on'), null);
  });
});

describe('where the operator is working', () => {
  it('holds notifications back while a desktop page is visible and in use, and only then', () => {
    const p = new Presence();
    const t = 5_000_000;
    assert.equal(p.atDesktop(t), null, 'nobody anywhere');
    p.report({ client: 'phone', mobile: true, visible: true, idleMs: 0 }, t);
    assert.equal(p.atDesktop(t), null, 'the phone being open is exactly when they want them');
    p.report({ client: 'desk', mobile: false, visible: false, idleMs: 0 }, t);
    assert.equal(p.atDesktop(t), null, 'a desktop tab in the background');
    p.report({ client: 'desk', mobile: false, visible: true, idleMs: 1000 }, t);
    assert.ok(p.atDesktop(t));
    assert.equal(p.atDesktop(t + PRESENCE_STALE_MS + 1), null, 'a page that stopped beating is gone');
    p.report({ client: 'desk', mobile: false, visible: true, idleMs: IN_USE_IDLE_MS + 1 }, t);
    assert.equal(p.atDesktop(t), null, 'open on a desk nobody is sitting at');
  });

  it('marks a moment told while held back, so leaving the desk brings no burst', () => {
    let quiet: string | null = 'at the desktop';
    let current = run({ agentStatus: 'working' });
    const sent: PushMessage[] = [];
    const alerts = new SessionAlerts(
      { runs: () => [current], question: () => null, lastWords: () => null, quiet: () => quiet },
      { send: async (m) => (sent.push(m), 1) },
    );
    alerts.tick(0);
    current = run();
    alerts.tick(1000);
    alerts.tick(1000 + DONE_SETTLE_MS);
    assert.equal(sent.length, 0);
    quiet = null;
    alerts.tick(1000 + DONE_SETTLE_MS * 2);
    assert.equal(sent.length, 0);
  });
});
