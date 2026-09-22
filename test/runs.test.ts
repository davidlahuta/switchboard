import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atPrompt,
  attentionFor,
  pendingQuestion,
  reaskMessage,
  clearedInPlace,
  limitSwapPlan,
  rebindDecision,
  rejectReservedArgs,
  processIsHost,
  reporterOf,
  reviveDecision,
  terminalEscape,
  sessionFileKey,
  rescueDecision,
  respawnGuard,
  stallDecision,
  earlierDeadline,
  mergePending,
  respawnPlacement,
  swapMethod,
  handoffDecision,
  hookOwner,
  handoffPrompt,
  HANDOFF_GRACE_MS,
  HANDOFF_GIVE_UP_MS,
  sessionDir,
  titleDecision,
  type PendingRespawn,
} from '../src/daemon/runs.ts';
import { readyForRespawn, safeToRespawn, waitsForShells, workSummary } from '../src/shared/respawn.ts';
import { looksFinished, startedWork, taskIdOf } from '../src/daemon/hooks.ts';
import { attentionMark, byAttention, GROUP_LABEL, QUIET_AFTER_MS, SESSION_GROUPS, sessionGroup, sessionMark, tabTitle } from '../src/shared/marks.ts';
import { readSessionModel } from '../src/daemon/transcript.ts';
import { headroomOf, modelWindows, SWAP_MARGIN, subscriptionScore, weightFor } from '../src/daemon/subscriptions.ts';
import { PTY_TERM, withoutParentSession } from '../src/config.ts';
import type { Run, SessionWork, Usage } from '../src/shared/types.ts';

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
  const base = {
    agentStatus: 'idle' as const,
    lastActivity: t('2026-01-01T10:00:00Z'),
    lastViewedAt: t('2026-01-01T10:00:00Z'),
    unread: 0,
    work: [] as SessionWork[],
  };

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

  it('does not call a session finished while its subagents are still going', () => {
    // Its own turn ended, so the status says idle and the activity is newer than the last look —
    // which used to read as "it has done something for you". It has not; it is mid-subagent.
    const subagent: SessionWork = { id: 'a1', kind: 'subagent', label: null, since: '', lastSeen: '' };
    const a = attentionFor({ ...base, lastActivity: t('2026-01-01T10:05:00Z'), work: [subagent] });
    assert.equal(a.unseen, false);
  });

  it('does call it finished when all it has left running is a shell', () => {
    const shell: SessionWork = { id: 'b1', kind: 'shell', label: 'npm run dev', since: '', lastSeen: '' };
    const a = attentionFor({ ...base, lastActivity: t('2026-01-01T10:05:00Z'), work: [shell] });
    assert.equal(a.unseen, true, 'a dev server is not the session working');
  });
});

describe('a session whose turn failed', () => {
  const base = {
    reason: 'api_error',
    agentStatus: 'idle' as const,
    ownUsedPct: 10,
    threshold: 85,
    unread: 0,
    tries: 0,
    continueOnResume: true,
  };

  it('is told to carry on, because nothing else is coming for it', () => {
    // No terminal died, so nothing revives it; no usage moved, so nothing swaps it. This is the
    // only thing between a turn that fell over at one in the morning and a desk that finds it at
    // seven exactly where it stopped.
    assert.equal(stallDecision(base), 'nudge');
  });

  it('leaves a session that is asking for a person', () => {
    assert.equal(stallDecision({ ...base, agentStatus: 'waiting' }), 'wait', 'a dialog is on screen');
    assert.equal(stallDecision({ ...base, unread: 2 }), 'wait', 'it has asked the operator something');
  });

  it('leaves one that is already going again', () => {
    assert.equal(stallDecision({ ...base, agentStatus: 'working' }), 'wait');
  });

  it('waits out a usage limit rather than typing into a session that would only hit it again', () => {
    assert.equal(stallDecision({ ...base, reason: 'rate_limit', ownUsedPct: 99 }), 'wait');
    assert.equal(stallDecision({ ...base, reason: 'rate_limit', ownUsedPct: 10 }), 'nudge', 'its window came back');
  });

  it('does not wait on usage for a cap the usage numbers cannot see', () => {
    // A spend cap is the account's own ceiling; no window percentage will ever move to announce it
    // is over, so the only way back is to try again later.
    assert.equal(stallDecision({ ...base, reason: 'a spend cap', ownUsedPct: 99 }), 'nudge');
  });

  it('stops asking a session that never picks up', () => {
    assert.equal(stallDecision({ ...base, tries: 8 }), 'stop-trying');
  });

  it('never asks a session the operator told to stay put', () => {
    assert.equal(stallDecision({ ...base, continueOnResume: false }), 'stop-trying');
  });
});

describe('answering one usage limit once', () => {
  const NOW = Date.parse('2026-09-11T06:28:53Z');

  it('refuses to take a session that came back seventeen milliseconds ago', () => {
    // The real number from the night this was written: a limit answered by the rescue sweep and by
    // the limit handler at once, two swaps 17ms apart, two claude processes on one conversation,
    // and a session that died instead of moving.
    assert.equal(respawnGuard({ lastRespawnAt: NOW - 17, now: NOW, force: false }), 'too-soon');
  });

  it('lets it through once the session has had time to come up', () => {
    assert.equal(respawnGuard({ lastRespawnAt: NOW - 60_000, now: NOW, force: false }), 'go');
    assert.equal(respawnGuard({ lastRespawnAt: null, now: NOW, force: false }), 'go');
  });

  it('never stands in the way of an operator who can see the screen', () => {
    assert.equal(respawnGuard({ lastRespawnAt: NOW - 17, now: NOW, force: true }), 'go');
  });

  it('keeps a session off a subscription whose model-scoped week is spent', () => {
    // A subscription can read 70% overall while the model the session runs on has nothing left, and
    // landing there buys a limit rather than room. Overnight this is what a swap kept finding.
    const usable = (scopedPct: number): boolean => scopedPct < 99;
    assert.equal(usable(74), true);
    assert.equal(usable(100), false);
  });

  it('prefers a subscription that is answering over one whose numbers are guesses', () => {
    const base = { headroom: 0.5, fullHeadroom: 1, liveRuns: 0, priority: 0, resetsInMs: null, recentlyLeft: false };
    assert.ok(subscriptionScore(base) > subscriptionScore({ ...base, stale: true }), 'stale numbers describe an earlier moment');
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

describe('what a session still has running', () => {
  const work = (kind: SessionWork['kind'], id = 'x'): SessionWork => ({ id, kind, label: null, since: '', lastSeen: '' });

  it('recognises a background shell by the handle the tool result hands back', () => {
    // Measured: a background Bash returns { ..., backgroundTaskId } and fires no hook of its own,
    // either when it starts or when it ends.
    assert.deepEqual(startedWork('Bash', { stdout: '', backgroundTaskId: 'bpylfmjzd' }), { id: 'bpylfmjzd', kind: 'shell' });
    assert.equal(startedWork('Bash', { stdout: 'done' }), null, 'an ordinary Bash leaves nothing running');
  });

  it('tells a monitor apart from a shell, since only one of them is watching something', () => {
    assert.equal(startedWork('Monitor', { backgroundTaskId: 'm1' })?.kind, 'monitor');
  });

  it('finds the task a later call is about, under every name Claude Code has used', () => {
    assert.equal(taskIdOf({ task_id: 't1' }), 't1');
    assert.equal(taskIdOf({ bash_id: 'b1' }), 'b1');
    assert.equal(taskIdOf({ shell_id: 's1' }), 's1');
    assert.equal(taskIdOf({ command: 'ls' }), null);
  });

  it('reads a peek at a task as an ending only when it says so', () => {
    assert.equal(looksFinished({ status: 'completed' }), true);
    assert.equal(looksFinished({ exitCode: 1 }), true);
    assert.equal(looksFinished({ status: 'running' }), false);
    assert.equal(looksFinished({ stdout: 'still going' }), false);
  });

  it('says what is open in the words the operator would use', () => {
    assert.equal(workSummary([work('subagent', 'a'), work('subagent', 'b'), work('shell', 'c')]), '2 subagents, 1 background shell');
    assert.equal(workSummary([work('monitor')]), '1 monitor');
    assert.equal(workSummary([]), '');
  });
});

describe('how long a queued respawn waits', () => {
  /*
   * A limit is not one event. Claude Code reprints the banner as it retries and the terminal
   * repaints, so the same limit arrives every few minutes — and each arrival used to re-queue the
   * swap with a fresh three-minute deadline, which is a deadline that never falls due.
   */
  it('keeps the patience already running when a plan is replaced', () => {
    const first = 1000;
    const again = 5000;
    assert.equal(earlierDeadline(first, again), first, 'asking again does not buy the session more time');
  });

  it('treats waiting for the turn to end as the longest patience there is', () => {
    // null is "however long the turn takes", so anything with a clock on it is sooner.
    assert.equal(earlierDeadline(null, 5000), 5000);
    assert.equal(earlierDeadline(5000, null), 5000);
    assert.equal(earlierDeadline(null, null), null);
  });
});

describe('which terminal a session comes back into', () => {
  it('gives a relaunch a new terminal, whatever the host is running', () => {
    assert.equal(respawnPlacement({ kind: 'relaunch', staleHost: false }), 'new-terminal');
  });

  it('reuses the terminal for a restart or a swap when its host is current', () => {
    assert.equal(respawnPlacement({ kind: 'restart', staleHost: false }), 'in-place');
    assert.equal(respawnPlacement({ kind: 'swap', staleHost: false }), 'in-place');
  });

  it('keeps the new terminal a swap was asked to absorb', () => {
    /*
     * Press "new terminal for every session" and then "rebalance": the second turns the first's
     * queued relaunch into a swap, and both were asked for. On a current host a swap comes back in
     * place, so without carrying the promise across the terminal the operator asked for would
     * silently not happen.
     */
    assert.equal(respawnPlacement({ kind: 'swap', staleHost: false, fresh: true }), 'new-terminal');
    assert.equal(respawnPlacement({ kind: 'restart', staleHost: false, fresh: true }), 'new-terminal');
    // And it is opt-in: nothing that did not absorb a relaunch is moved out of its terminal.
    assert.equal(respawnPlacement({ kind: 'swap', staleHost: false, fresh: false }), 'in-place');
  });

  it('replaces an out-of-date terminal on every automated way back', () => {
    // An update restart and a subscription swap both bring the session back on a new claude; doing
    // that inside a host that predates the current build is what leaves a session badged old host
    // for the rest of its life.
    for (const kind of ['restart', 'swap'] as const) {
      assert.equal(respawnPlacement({ kind, staleHost: true }), 'new-terminal', kind);
    }
  });
});

describe('a second respawn asked for while one waits', () => {
  const plan = (over: Partial<PendingRespawn>): PendingRespawn => ({
    target: 'here',
    reason: 'r',
    continueAfter: false,
    kind: 'restart',
    trigger: 'manual',
    queuedAt: 1000,
    deadline: null,
    ...over,
  });
  const place = (p: PendingRespawn) => respawnPlacement({ kind: p.kind, staleHost: false, fresh: p.fresh });

  it('keeps a queued move when a new terminal is asked for, and opens the terminal too', () => {
    // Rebalance, then "new terminal for every session": both were asked for.
    const merged = mergePending(plan({ kind: 'swap', target: 'there', trigger: 'rebalance' }), plan({ kind: 'relaunch', queuedAt: 2000 }));
    assert.equal(merged.kind, 'swap');
    assert.equal(merged.target, 'there');
    assert.equal(merged.trigger, 'rebalance');
    assert.equal(place(merged), 'new-terminal', 'on a current host too');
  });

  it('turns a queued new terminal into a move that still opens one', () => {
    const merged = mergePending(plan({ kind: 'relaunch' }), plan({ kind: 'swap', target: 'there', trigger: 'rebalance' }));
    assert.equal(merged.kind, 'swap');
    assert.equal(place(merged), 'new-terminal');
  });

  it('does not let a restart cancel a move', () => {
    const merged = mergePending(plan({ kind: 'swap', target: 'there' }), plan({ kind: 'restart', trigger: 'update' }));
    assert.equal(merged.kind, 'swap');
    assert.equal(merged.target, 'there');
    assert.equal(place(merged), 'in-place', 'nobody asked for a terminal');
  });

  it('lets a later move replace an earlier one', () => {
    const merged = mergePending(plan({ kind: 'swap', target: 'there' }), plan({ kind: 'swap', target: 'elsewhere', trigger: 'limit' }));
    assert.equal(merged.target, 'elsewhere');
    assert.equal(merged.trigger, 'limit');
  });

  it('keeps the shorter patience, the first ask time and any promised continue', () => {
    const merged = mergePending(
      plan({ kind: 'swap', deadline: 9000, continueAfter: true, queuedAt: 1000 }),
      plan({ kind: 'swap', deadline: null, continueAfter: false, queuedAt: 5000 }),
    );
    assert.equal(merged.deadline, 9000);
    assert.equal(merged.queuedAt, 1000);
    assert.equal(merged.continueAfter, true);
  });

  it('is the new plan unchanged when nothing was waiting', () => {
    const next = plan({ kind: 'swap', target: 'there' });
    assert.equal(mergePending(undefined, next), next);
  });
});

describe('when a resumed session is ready to be told to carry on', () => {
  const rule = '─'.repeat(60);

  it('is ready once the input box and its footer are drawn', () => {
    // As 0376 literal reader's screen read at 17:32, after its resume.
    const screen = ['  ✻ Cogitated for 4m 17s · done 7:21 PM', rule, '❯', rule, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n');
    assert.equal(atPrompt(screen), true);
  });

  it('is ready in the default permission mode too', () => {
    assert.equal(atPrompt([rule, '> ', rule, '  ? for shortcuts'].join('\n')), true);
  });

  it('is not ready while the conversation is still loading', () => {
    assert.equal(atPrompt(['Resuming conversation…', '', ''].join('\n')), false);
  });

  it('is not ready while a dialog is asking something, even with a footer on screen', () => {
    // A carriage return here answers the dialog, which on the trust prompt means "No, exit".
    const screen = ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit', 'Enter to confirm · Esc to cancel', '(shift+tab to cycle)'].join('\n');
    assert.equal(atPrompt(screen), false);
  });
});

describe('a session that went down waiting on the operator', () => {
  const rec = (o: object): string => JSON.stringify(o);
  const ask = (id: string, question: string) =>
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question }] } }] } });
  const prose = (text: string) => rec({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const result = (id: string) => rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'answered' }] } });

  it('finds the question it was still waiting on', () => {
    // As 0327 audit subject resolver's transcript ended at 00:01, before the desk went down.
    const t = [prose('One finding needs your ruling.'), ask('t1', 'Rule on the MEDIUM finding?'), rec({ type: 'system', subtype: 'x' })].join('\n');
    assert.equal(pendingQuestion(t), 'Rule on the MEDIUM finding?');
  });

  it('is not waiting once the question has its answer', () => {
    assert.equal(pendingQuestion([ask('t1', 'Merge?'), result('t1'), prose('Merged.')].join('\n')), null);
  });

  it('is not waiting when a prompt was typed after the question', () => {
    assert.equal(pendingQuestion([ask('t1', 'Merge?'), rec({ type: 'user', message: { content: 'do something else' } })].join('\n')), null);
  });

  it('ignores thinking after the question and subagents asking their own', () => {
    const thinking = rec({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } });
    const sub = rec({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } });
    assert.equal(pendingQuestion([ask('t1', 'Merge?'), thinking, sub].join('\n')), 'Merge?');
  });

  it('reads a tail that starts part-way through a line', () => {
    assert.equal(pendingQuestion(['ntent":[]}}', ask('t2', 'Which option?')].join('\n')), 'Which option?');
  });

  it('tells the session to ask again and not to decide itself', () => {
    const m = reaskMessage('Rule on the MEDIUM finding?');
    assert.ok(m.includes('Rule on the MEDIUM finding?'));
    assert.ok(/ask it again/i.test(m) && /do not decide it yourself/i.test(m));
  });
});

describe('the folder a session comes back in', () => {
  const all = (): boolean => true;
  const repo = path.resolve('/repos/harnesty');

  it('keeps a worktree inside the folder it was started in', () => {
    const worktree = path.join(repo, '.claude', 'worktrees', 'spec-0071');
    assert.equal(sessionDir(repo, worktree, all), worktree);
  });

  it('does not follow the session into a folder outside it, such as its temp scratchpad', () => {
    const scratchpad = path.resolve('/Users/d/AppData/Local/Temp/claude/x/scratchpad');
    assert.equal(sessionDir(repo, scratchpad, all), repo);
  });

  it('opens a plain subfolder at the root of the working tree it belongs to', () => {
    // .docs/specs is the repository's folder, not a project of its own.
    const specs = path.join(repo, '.docs', 'specs');
    const exists = (d: string): boolean => d === specs || d === path.join(repo, '.git');
    assert.equal(sessionDir(repo, specs, exists), repo);
  });

  it('opens a subfolder of a worktree at that worktree', () => {
    const worktree = path.join(repo, '.claude', 'worktrees', 'spec-0071');
    const deep = path.join(worktree, 'src', 'lib');
    const exists = (d: string): boolean => d === deep || d === path.join(worktree, '.git') || d === path.join(repo, '.git');
    assert.equal(sessionDir(repo, deep, exists), worktree);
  });

  it('does not mistake a sibling that shares the name for a subfolder', () => {
    assert.equal(sessionDir(repo, `${repo}-old`, all), repo);
  });

  it('opens where it started when the last folder is gone, rather than nowhere', () => {
    const gone = path.join(repo, '.claude', 'worktrees', 'deleted');
    assert.equal(sessionDir(repo, gone, (d) => d !== gone), repo);
  });

  it('opens where it started when nothing else is known', () => {
    assert.equal(sessionDir(repo, null, all), repo);
  });
});

describe('when a session is taken for a restart, swap or relaunch', () => {
  it('waits for a subagent that outlived the turn that launched it', () => {
    // Measured: the parent's Stop hook arrives while a background subagent is still thinking, and
    // the session reads as idle for as long as the subagent takes.
    const sub = (kind: SessionWork['kind']): SessionWork => ({ id: 'a1', kind, label: null, since: '', lastSeen: '' });
    assert.equal(readyForRespawn({ status: 'idle', work: [] }), true);
    assert.equal(readyForRespawn({ status: 'idle', work: [sub('subagent')] }), false);
  });

  it('waits for a background shell before a respawn nobody needed this minute', () => {
    /*
     * Run 29e12d39 started its recipe in the background, ended its turn to wait for it, and was
     * taken for a rebalance one second later. The recipe died with the process six minutes into a
     * twelve-minute run, and the session came back holding a plan that waited on a result only the
     * dead process could have been woken with.
     */
    const work = (kind: SessionWork['kind']): SessionWork => ({ id: 'b1', kind, label: null, since: '', lastSeen: '' });
    for (const trigger of ['rebalance', 'manual', 'update', 'proactive'] as const) {
      assert.equal(readyForRespawn({ status: 'idle', work: [work('shell')], trigger }), false, trigger);
      assert.equal(readyForRespawn({ status: 'idle', work: [work('monitor')], trigger }), false, trigger);
    }
  });

  it('does not keep a session stuck for a shell when it cannot run where it is', () => {
    // Out of usage, or with its terminal already gone: the shell is doing it no good.
    const work = (kind: SessionWork['kind']): SessionWork => ({ id: 'b1', kind, label: null, since: '', lastSeen: '' });
    for (const trigger of ['limit', 'rescue', 'revive'] as const) {
      assert.equal(readyForRespawn({ status: 'limited', work: [work('shell')], trigger }), true, trigger);
      assert.ok(!waitsForShells(trigger), trigger);
    }
  });

  it('still waits for a subagent however urgent the respawn', () => {
    const sub: SessionWork = { id: 'a1', kind: 'subagent', label: null, since: '', lastSeen: '' };
    assert.equal(readyForRespawn({ status: 'idle', work: [sub], trigger: 'rebalance' }), false);
    assert.equal(readyForRespawn({ status: 'idle', work: [sub], trigger: 'limit' }), false);
  });

  it('does not count a shell as busy when nobody is asking about a respawn', () => {
    // The web asks "does this session look busy", which is a different question.
    const shell: SessionWork = { id: 'b1', kind: 'shell', label: null, since: '', lastSeen: '' };
    assert.equal(readyForRespawn({ status: 'idle', work: [shell] }), true);
  });

  it('still protects a running turn whatever else is open', () => {
    assert.equal(readyForRespawn({ status: 'working', work: [] }), false);
  });


  it('waits for a turn that is running rather than cutting it', () => {
    assert.equal(safeToRespawn('working'), false);
    assert.equal(safeToRespawn('starting'), false);
    assert.equal(safeToRespawn('waiting'), false);
  });

  it('goes at once when there is no turn to protect', () => {
    // limited means the turn ended on a limit; undefined means no agent has ever reported.
    assert.equal(safeToRespawn('idle'), true);
    assert.equal(safeToRespawn('limited'), true);
    assert.equal(safeToRespawn(undefined), true);
  });
});

describe('picking a session up off a usage limit', () => {
  const threshold = 85;

  it('tells it to carry on once its own subscription has room', () => {
    // Nothing to gain from a move: it is already sitting on the conversation it wants.
    assert.equal(rescueDecision({ ownUsedPct: 12, bestElsewherePct: 3, threshold }), 'continue');
  });

  it('moves it to a subscription that still has capacity, threshold or no threshold', () => {
    // 90% is past the bar that stops a *running* session moving, and it is still far better than
    // the nothing it has where it is.
    assert.equal(rescueDecision({ ownUsedPct: 100, bestElsewherePct: 90, threshold }), 'move');
  });

  it('waits when everywhere else is spent too', () => {
    assert.equal(rescueDecision({ ownUsedPct: 100, bestElsewherePct: 99, threshold }), 'wait');
    assert.equal(rescueDecision({ ownUsedPct: 100, bestElsewherePct: null, threshold }), 'wait');
  });

  it('prefers staying put to moving when both would work', () => {
    assert.equal(rescueDecision({ ownUsedPct: 40, bestElsewherePct: 0, threshold }), 'continue');
  });
});

describe('the session id a hosted process reports for itself', () => {
  const OLD = '62bd299f-2de0-419b-a1c3-c01f0b0e3866';
  const NEW = '20d0c5f4-3981-43f0-af5c-d9136e85dc95';

  it('says nothing about the id the run already holds', () => {
    assert.equal(rebindDecision(OLD, OLD, null, 'hosted'), 'ignore');
    assert.equal(rebindDecision(OLD, OLD, OLD, 'hosted'), 'ignore', 'and that is the resume confirming itself');
    assert.equal(rebindDecision(OLD, OLD, null, 'elsewhere'), 'ignore', 'whoever says it, it changes nothing');
  });

  it('follows a session that started a new conversation on its own', () => {
    // /clear in a session nobody asked to resume: the run has to follow it or it points at nothing.
    assert.equal(rebindDecision(OLD, NEW, null, 'cleared'), 'adopt');
    assert.equal(rebindDecision(OLD, NEW, null, 'hosted'), 'adopt', 'and so does the terminal coming up somewhere new');
  });

  it('refuses the new conversation a failed resume comes up on', () => {
    // Claude Code answers a transcript it cannot load with a new conversation rather than an exit.
    // Adopting that id was how a day's work stopped being reachable while its transcript sat on
    // disk untouched, so the run keeps the id it was sent to resume and the session is stopped.
    assert.equal(rebindDecision(OLD, NEW, OLD, 'hosted'), 'lost');
  });

  it('still follows a /clear once the resume has been confirmed', () => {
    // The guard is dropped the moment the process reports the id it was asked for, so the session
    // is free to change conversations afterwards the way any other session can.
    assert.equal(rebindDecision(NEW, NEW, NEW, 'hosted'), 'ignore');
    assert.equal(rebindDecision(NEW, 'later-one', null, 'cleared'), 'adopt');
  });

  it('ignores a claude that is carrying the run id but is not the session', () => {
    /*
     * The run id travels in the environment, so anything a hosted session starts inherits it, and
     * so did anything the daemon started back when it was launched from inside one. `claude update`
     * and `claude mcp list` each open a conversation of their own for a moment and fire a lone
     * SessionEnd on the way out under that borrowed id. Adopting it pointed the run at a
     * conversation that had already ended and never had anything in it, and the real one — 8500
     * lines and $145 of it — stopped being reachable from the board while its transcript sat on
     * disk untouched. Nobody outside the terminal gets to say which conversation a run is on.
     */
    assert.equal(rebindDecision(OLD, NEW, null, 'elsewhere'), 'stray');
  });

  it('would rather stop a terminal than guess during a resume', () => {
    // Between the spawn and the id coming back, our own failed resume and a stranger look the same.
    // Calling it a failed resume stops the session and says so, and the conversation survives that;
    // calling it a stranger leaves a terminal running a conversation the run has quietly disowned.
    assert.equal(rebindDecision(OLD, NEW, OLD, 'elsewhere'), 'lost');
  });
});

describe('remembering where Claude Code keeps a session’s files', () => {
  const RUN = '29e12d39';
  const WAS = '2448f413-bf27-4558-a496-6d47eecb0549';
  const NOW = '2cd9f4ad-4326-4355-911c-bfd0ed7ff94a';

  it('forgets the file when the run changes conversations', () => {
    /*
     * A run outlives its conversations, and every one of them has its own `custom-title.json`. A
     * key that named only the run went on answering with the dead conversation's file for as long
     * as that file existed — so the poll kept reading a title from a session that had been offline
     * since morning and writing it back over the one the operator had just typed. Every rename took
     * and was undone a second later, in both directions, for hours.
     */
    assert.notEqual(sessionFileKey(RUN, WAS, 'custom-title.json'), sessionFileKey(RUN, NOW, 'custom-title.json'));
  });

  it('keeps answering for the same session and file', () => {
    assert.equal(sessionFileKey(RUN, NOW, 'custom-title.json'), sessionFileKey(RUN, NOW, 'custom-title.json'));
  });

  it('does not confuse two runs that are somehow on one conversation', () => {
    assert.notEqual(sessionFileKey('29e12d39', NOW, 'custom-title.json'), sessionFileKey('f43be2f0', NOW, 'custom-title.json'));
  });
});

describe('whether the claude reporting an id is the one the run is hosting', () => {
  const MINE = '20d0c5f4-3981-43f0-af5c-d9136e85dc95';
  const THEIRS = '9be19eba-b4d0-4193-a3ea-e9d4ade34a0e';
  const never = (): string | null => {
    throw new Error('the registry should not have been read');
  };

  it('believes the process the runner started', () => {
    assert.equal(reporterOf({ kind: 'hook', event: 'SessionStart', source: 'startup' }, MINE, 4242, () => MINE), 'hosted');
  });

  it('does not believe one that is merely carrying the run id', () => {
    // `claude update` and `claude mcp list` inherit it and fire a lone SessionEnd on the way out.
    assert.equal(reporterOf({ kind: 'hook', event: 'SessionEnd', source: null }, THEIRS, 4242, () => MINE), 'elsewhere');
  });

  it('takes a /clear on its word, so a changed conversation is followed even unread', () => {
    // The file is how a process is identified, and it is not there on every build or every platform.
    assert.equal(reporterOf({ kind: 'hook', event: 'SessionStart', source: 'clear' }, THEIRS, 4242, never), 'cleared');
  });

  it('asks nothing of the registry when there is no pid to ask about', () => {
    assert.equal(reporterOf({ kind: 'hook', event: 'Stop', source: null }, THEIRS, null, never), 'elsewhere');
  });

  it('follows a conversation the hosted process moved into a background job: spec-0464', () => {
    // sessions/54008.json: {"sessionId":"a4ea9029-…","parkedJobId":"874e1fbc"}; the job reports 874e1fbc-6686-….
    const JOB = '874e1fbc-6686-49cd-b83a-19e857c2771e';
    const prompt = { kind: 'hook', event: 'UserPromptSubmit', source: null } as const;
    assert.equal(reporterOf(prompt, JOB, 54008, () => MINE, () => '874e1fbc'), 'parked');
    assert.equal(rebindDecision(MINE, JOB, null, 'parked'), 'adopt');
  });

  it('does not take a job it did not park for its own', () => {
    const prompt = { kind: 'hook', event: 'UserPromptSubmit', source: null } as const;
    assert.equal(reporterOf(prompt, THEIRS, 54008, () => MINE, () => '874e1fbc'), 'elsewhere', 'parked something else');
    assert.equal(reporterOf(prompt, THEIRS, 54008, () => MINE, () => null), 'elsewhere', 'parked nothing');
    assert.equal(reporterOf(prompt, THEIRS, 54008, () => MINE), 'elsewhere', 'no registry entry to say');
  });
});

describe('whether a session whose terminal seems gone is brought back', () => {
  it('opens nothing for a run whose runner has already said hello', () => {
    assert.equal(reviveDecision({ connected: true, claudeAlive: true, heldForMs: null }), 'already-back');
    assert.equal(reviveDecision({ connected: true, claudeAlive: false, heldForMs: null }), 'already-back');
  });

  it('holds a revive while the run’s claude is still running', () => {
    /*
     * A daemon restarted on a machine short of memory took eighteen of the revive's thirty seconds
     * to start listening, and every run was relaunched while every runner was still reconnecting:
     * ten new terminals for ten conversations that were each still live in their own. A running
     * claude is a terminal that still exists.
     */
    assert.equal(reviveDecision({ connected: false, claudeAlive: true, heldForMs: null }), 'hold');
    assert.equal(reviveDecision({ connected: false, claudeAlive: true, heldForMs: 60_000 }), 'hold');
  });

  it('stops holding once the runner has had long enough to come back', () => {
    // A runner that died can leave its claude running with nothing attached, and that session still
    // has to come back.
    assert.equal(reviveDecision({ connected: false, claudeAlive: true, heldForMs: 6 * 60_000 }), 'revive');
  });

  it('brings back a session whose claude is gone', () => {
    assert.equal(reviveDecision({ connected: false, claudeAlive: false, heldForMs: null }), 'revive');
  });
});

describe('a terminal that was opened for a session and stayed empty', () => {
  const alive = { connected: false, alive: true };

  it('asks for nothing when the runner turned up after all', () => {
    // wt exits 0 the moment it has handed the request over, so the only proof a terminal worked is
    // the runner saying hello — which it may do on the last of the forty-five seconds.
    assert.deepEqual(terminalEscape({ tries: 1, connected: true, alive: true }), { do: 'nothing' });
  });

  it('asks for nothing for a session that is over', () => {
    // Stopped or exited: nobody is waiting for this terminal.
    assert.deepEqual(terminalEscape({ tries: 1, connected: false, alive: false }), { do: 'nothing' });
  });

  it('moves the session out of the window that would not start it', () => {
    /*
     * The 2026-09-22 failure: one Windows Terminal window stopped starting processes, six sessions
     * lost their terminal to a restart in the same second, and every wt still exited 0. A window of
     * its own works on the same desk in the same second.
     */
    assert.deepEqual(terminalEscape({ ...alive, tries: 1 }), { do: 'try-elsewhere', step: 1 });
  });

  it('gives up Windows Terminal altogether when a window of its own is empty too', () => {
    assert.deepEqual(terminalEscape({ ...alive, tries: 2 }), { do: 'try-elsewhere', step: 2 });
  });

  it('stops opening terminals once there is nowhere left to open one', () => {
    // Not the session abandoned: the revive backoff takes it, and each of its attempts is watched
    // by this same rule.
    assert.deepEqual(terminalEscape({ ...alive, tries: 3 }), { do: 'give-up' });
    assert.deepEqual(terminalEscape({ ...alive, tries: 9 }), { do: 'give-up' });
  });
});

describe('which process an MCP connection belongs to', () => {
  const RUN = '5f2e3846-9601-40b5-9e13-d12a462b1713';
  const OTHER = '2cd9f4ad-4326-4355-911c-bfd0ed7ff94a';
  const never = (): string | null => {
    throw new Error('the registry should not have been read');
  };

  it('is the run’s when the process that started it is the one the runner spawned', () => {
    assert.equal(processIsHost({ claimedPid: 50304, hostPid: 50304, runSession: RUN, sessionOfClaimed: never }), true);
  });

  it('still is the run’s after a /clear, whatever conversation the shim goes on claiming', () => {
    /*
     * The shim's own idea of its conversation is set when its process starts and never updated.
     * After the run cleared into 5f2e3846 its shim went on announcing 2cd9f4ad, and the one time
     * that claim was believed the run moved back onto the conversation it had left. The claim is
     * not an input here at all, so there is nothing for it to get wrong.
     */
    assert.equal(processIsHost({ claimedPid: 50304, hostPid: 50304, runSession: RUN, sessionOfClaimed: never }), true);
  });

  it('is the run’s for the new claude a respawn has started before its pid is recorded', () => {
    assert.equal(processIsHost({ claimedPid: 48492, hostPid: 50304, runSession: RUN, sessionOfClaimed: () => RUN }), true);
  });

  it('is not the run’s when it came from another claude carrying the run id', () => {
    // A `claude -p` run from the session's own shell: a different process, in a conversation of its own.
    assert.equal(processIsHost({ claimedPid: 7777, hostPid: 50304, runSession: RUN, sessionOfClaimed: () => OTHER }), false);
    assert.equal(processIsHost({ claimedPid: 7777, hostPid: 50304, runSession: RUN, sessionOfClaimed: () => null }), false);
  });

  it('is nobody’s when it will not say which process started it', () => {
    assert.equal(processIsHost({ claimedPid: null, hostPid: 50304, runSession: RUN, sessionOfClaimed: never }), false);
  });
});

describe('what a hook says about where a new conversation came from', () => {
  it('knows the two events that change a conversation without restarting the process', () => {
    assert.ok(clearedInPlace('SessionStart', 'clear'));
    assert.ok(clearedInPlace('SessionStart', 'compact'));
  });

  it('and does not take a fresh process for one of them', () => {
    // A resume that failed, or any claude starting up, reports `startup` — which says nothing about
    // whether it is the process this run is hosting.
    assert.ok(!clearedInPlace('SessionStart', 'startup'));
    assert.ok(!clearedInPlace('SessionStart', null));
    assert.ok(!clearedInPlace('SessionEnd', 'clear'), 'a session on its way out is never the one to follow');
  });
});

describe('a hosted session belongs to no other session', () => {
  it('drops the launching session marks and keeps everything else', () => {
    const env = withoutParentSession({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/profiles/one',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_PID: '4242',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/bin/claude',
    });

    // The marker is why this matters: claude stops writing a transcript for a session it thinks is a
    // child, and a session with no transcript cannot be resumed after a swap.
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
    assert.equal(env.CLAUDE_PID, undefined);

    // Switchboard's own per-subscription setting is not the parent's, and has to survive.
    assert.equal(env.CLAUDE_CONFIG_DIR, '/profiles/one');
    assert.equal(env.PATH, '/usr/bin');
  });

  it('leaves an ordinary environment alone', () => {
    assert.deepEqual(withoutParentSession({ PATH: '/usr/bin', HOME: '/home/x' }), { PATH: '/usr/bin', HOME: '/home/x' });
  });

  it('does not hand Switchboard’s own run id to a claude that is not the session', () => {
    /*
     * The hooks carry this as a header and the daemon reads it as "this run is speaking", so it is
     * the one variable that can rewrite which conversation a run is on. A daemon started from
     * inside a hosted session carries that session's id, and passed it to every claude it ran for
     * housekeeping — `claude update`, `claude doctor`, `claude mcp list`. Each opens a conversation
     * of its own and fires a lone SessionEnd under the borrowed id, and one of them renamed a run
     * onto a conversation that had never held anything.
     *
     * A session that should have it is given it explicitly, by buildSpec, after this has run.
     */
    assert.equal(withoutParentSession({ PATH: '/usr/bin', SWITCHBOARD_RUN_ID: '803c73e5' }).SWITCHBOARD_RUN_ID, undefined);
  });

  it('does not let the launching terminal decide how sessions look', () => {
    // Claude Code sets NO_COLOR=1 on everything it launches. A daemon started from inside a session
    // handed that down, and every session it opened rendered in black and white.
    const env = withoutParentSession({
      PATH: '/usr/bin',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      COLORTERM: '',
      TERM_PROGRAM: 'vscode',
    });
    assert.equal(env.NO_COLOR, undefined);
    assert.equal(env.FORCE_COLOR, undefined);
    assert.equal(env.TERM, undefined, 'the pseudo-terminal the runner makes says what TERM is');
    assert.equal(env.TERM_PROGRAM, undefined);
    assert.equal(env.PATH, '/usr/bin');

    // And what the runner then says about the terminal it actually created.
    assert.equal(PTY_TERM.TERM, 'xterm-256color');
    assert.equal(PTY_TERM.COLORTERM, 'truecolor');
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

  /*
   * What a rebalance has that a loop of single swaps does not: each move is counted before the next
   * session is asked. Without it every session on the desk is told the same emptiest subscription,
   * because a swap is queued behind its own turn and the live counts do not move for minutes.
   */
  it('stops a whole desk being sent to the same empty subscription', () => {
    const roomy = { ...base, headroom: 1.0 };
    const second = { ...base, headroom: 0.7 };
    assert.ok(subscriptionScore(roomy) > subscriptionScore(second), 'the first session goes to the roomiest');
    // Having just been given one, it is worth less to the next session than the runner-up.
    const afterOne = subscriptionScore({ ...roomy, liveRuns: roomy.liveRuns + 1 });
    assert.ok(afterOne < subscriptionScore(second), 'the second session goes somewhere else');
  });

  it('makes staying put worth more as the neighbours leave', () => {
    // The other half of the same bookkeeping: a subscription a rebalance has taken a session off is
    // a better place for the sessions still on it, so they are not moved on numbers already stale.
    const crowded = { ...base, liveRuns: 3 };
    assert.ok(subscriptionScore({ ...crowded, liveRuns: 2 }) > subscriptionScore(crowded));
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

  it('holds a session on Fable to what is left of the Fable week', () => {
    const fable = { ...usage(5, 30), scoped: [{ label: 'Fable', pct: 90, resetsAt: null }] };
    assert.equal(headroomOf(fable, 20, 'claude-fable-5-1').headroom, 2, 'a tenth of the Fable week left');
    assert.equal(headroomOf(fable, 20, 'claude-opus-5').headroom, 14, 'another model has the account-wide week');
    assert.equal(headroomOf(fable, 20).headroom, 14, 'no model known: only the account-wide windows');
    assert.equal(headroomOf(fable, 20, 'claude-fable-5-1').bindingWindow, 'sevenDay', 'what the subscription list shows is unchanged');
  });

  it('ranks subscriptions for a Fable session by their Fable weeks', () => {
    // A: an empty account-wide week but a Fable week nearly gone. B: busier overall, plenty of Fable.
    const a = { ...usage(0, 10), scoped: [{ label: 'Fable', pct: 95, resetsAt: null }] };
    const b = { ...usage(0, 50), scoped: [{ label: 'Fable', pct: 20, resetsAt: null }] };
    assert.ok(headroomOf(b, 20, 'claude-fable-5-1').headroom > headroomOf(a, 20, 'claude-fable-5-1').headroom);
    assert.ok(headroomOf(a, 20, 'claude-opus-5').headroom > headroomOf(b, 20, 'claude-opus-5').headroom, 'and the other way round for Opus');
    assert.deepEqual(modelWindows(a, 'claude-fable-5-1').map((w) => w.label), ['Fable']);
    assert.deepEqual(modelWindows(a, 'claude-opus-5'), []);
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

describe('what a terminal tab says it wants', () => {
  const base: Pick<Run, 'status' | 'agentStatus' | 'attention' | 'work'> = {
    status: 'running',
    agentStatus: 'idle',
    attention: { waiting: false, unread: 0, unseen: false },
    work: [],
  };
  const mark = (over: Partial<typeof base>): string => sessionMark({ ...base, ...over } as Run)?.glyph ?? '';

  it('marks nothing on a session that is idle and has been read', () => {
    // A mark on every tab is a mark worth nothing; the empty ones are what make the others carry.
    assert.equal(mark({}), '');
  });

  it('puts being stopped on a prompt above everything else', () => {
    assert.equal(mark({ agentStatus: 'waiting', attention: { waiting: true, unread: 3, unseen: true } }), '❗');
  });

  it('shows that it has spoken to the operator before that it is busy', () => {
    assert.equal(mark({ agentStatus: 'working', attention: { waiting: false, unread: 1, unseen: false } }), '✉');
  });

  it('shows work in progress, and a finished turn nobody has looked at', () => {
    assert.equal(mark({ agentStatus: 'working' }), '●');
    assert.equal(mark({ agentStatus: 'starting' }), '●');
    assert.equal(mark({ agentStatus: 'limited' }), '⏳');
    assert.equal(mark({ attention: { waiting: false, unread: 0, unseen: true } }), '✓');
  });

  it('says nothing about a session that has ended', () => {
    assert.equal(mark({ status: 'exited', attention: { waiting: false, unread: 2, unseen: true } }), '');
  });
});

describe('the order a desk full of sessions is read in', () => {
  const NOW = Date.parse('2026-09-15T12:00:00Z');
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();
  const run = (over: Partial<Run>): Run =>
    ({
      status: 'running',
      agentStatus: 'idle',
      name: 'apex',
      work: [],
      attention: { waiting: false, unread: 0, unseen: false },
      lastActivity: ago(5 * 60_000),
      ...over,
    }) as Run;
  const order = (...runs: Run[]): string[] => [...runs].sort(byAttention(NOW)).map((r) => r.name);

  it('puts what is blocked above what is merely talking, and both above what is running', () => {
    const blocked = run({ name: 'blocked', agentStatus: 'waiting', attention: { waiting: true, unread: 0, unseen: false } });
    const spoke = run({ name: 'spoke', attention: { waiting: false, unread: 2, unseen: true } });
    const working = run({ name: 'working', agentStatus: 'working' });
    assert.deepEqual(order(working, spoke, blocked), ['blocked', 'spoke', 'working']);
  });

  it('does not let a session nobody has opened for a week sit on top of the desk', () => {
    /*
     * The complaint this order was rewritten for. "Has done something you have not read" never
     * expires, so two sessions parked days ago — finished, unread, wanting nothing — held the head
     * of both lists permanently, above everything that was actually running. Opening a terminal
     * nobody wanted to open was the only way to clear it.
     */
    const parked = run({ name: 'serensia', attention: { waiting: false, unread: 0, unseen: true }, lastActivity: ago(6 * 24 * 3600_000) });
    const working = run({ name: 'harnesty', agentStatus: 'working' });
    assert.equal(sessionGroup(parked, NOW), 'parked');
    assert.deepEqual(order(parked, working), ['harnesty', 'serensia']);
  });

  it('keeps a session that has just gone quiet where it was', () => {
    // It ended a turn a moment ago; it is still the thing being worked on, and a list that moved it
    // out the instant it stopped typing would move it back on the next prompt.
    const justDone = run({ name: 'justDone', attention: { waiting: false, unread: 0, unseen: true }, lastActivity: ago(60_000) });
    assert.equal(sessionGroup(justDone, NOW), 'active');
  });

  it('holds a long turn in the active group even when no hook has fired for an hour', () => {
    // Sessions go quiet mid-work — a build, a thinking subagent — and the clock is not evidence
    // against a session that says it is working.
    const grinding = run({ name: 'grinding', agentStatus: 'working', lastActivity: ago(2 * 3600_000) });
    assert.equal(sessionGroup(grinding, NOW), 'active');
    const delegating = run({ name: 'delegating', lastActivity: ago(2 * 3600_000), work: [{ kind: 'subagent' } as never] });
    assert.equal(sessionGroup(delegating, NOW), 'active');
    const limited = run({ name: 'limited', agentStatus: 'limited', lastActivity: ago(2 * 3600_000) });
    assert.equal(sessionGroup(limited, NOW), 'active', 'it comes back on its own when the window resets');
  });

  it('holds still while sessions work, because nothing inside a group moves', () => {
    /*
     * lastActivity is the agent's last hook, and a working session fires one every few seconds. The
     * list used to sort on it, so it re-ordered itself continuously and rows moved out from under
     * whoever was reading them — movement that carried no information, because every session was
     * doing it. Inside a group the order is the name, which does not change while you read.
     */
    const a = run({ name: 'alpha', agentStatus: 'working', lastActivity: ago(1000) });
    const b = run({ name: 'beta', agentStatus: 'working', lastActivity: ago(9 * 60_000) });
    const before = order(a, b);
    const later = [...[a, b].map((r) => ({ ...r, lastActivity: ago(0) }) as Run)].sort(byAttention(NOW + 1000)).map((r) => r.name);
    assert.deepEqual(before, ['alpha', 'beta']);
    assert.deepEqual(later, before, 'a hook firing anywhere reshuffles nothing');
  });

  it('sends what has exited to the bottom, newest first', () => {
    const old = run({ name: 'old', status: 'exited', endedAt: ago(3 * 3600_000) });
    const recent = run({ name: 'recent', status: 'exited', endedAt: ago(60_000) });
    const blocked = run({ name: 'blocked', status: 'exited', endedAt: ago(2 * 3600_000), attention: { waiting: true, unread: 9, unseen: true } });
    const live = run({ name: 'live' });
    assert.deepEqual(order(old, recent, blocked, live), ['live', 'recent', 'blocked', 'old']);
  });

  it('names every group it can sort into', () => {
    for (const g of SESSION_GROUPS) assert.ok(GROUP_LABEL[g], `${g} has a label`);
  });

  it('parks a session the moment it has been quiet long enough, and not before', () => {
    const edge = run({ name: 'edge', lastActivity: ago(QUIET_AFTER_MS - 1000) });
    assert.equal(sessionGroup(edge, NOW), 'active');
    assert.equal(sessionGroup(run({ name: 'edge', lastActivity: ago(QUIET_AFTER_MS + 1000) }), NOW), 'parked');
  });
});

describe('one mark, wherever a session is shown', () => {
  const run = (over: Partial<Run>): Run =>
    ({ status: 'running', agentStatus: 'idle', name: 'apex', work: [], attention: { waiting: false, unread: 0, unseen: false }, ...over }) as Run;

  it('says the same thing in a tab as in the web list', () => {
    const waiting = run({ agentStatus: 'waiting', attention: { waiting: true, unread: 0, unseen: false } });
    assert.equal(attentionMark(waiting)?.glyph, sessionMark(waiting)?.glyph);
    assert.equal(tabTitle(waiting, 'apex'), '❗ apex');
  });

  it('counts a session that has stopped trying as waiting on a person', () => {
    // No next attempt means nothing is coming for it but an operator. It used to carry the mark for
    // "finished something you have not read" — which is what a session that is done looks like.
    const gaveUp = run({ stalled: { reason: 'a spend cap', since: '', nextTry: null, tries: 8 }, attention: { waiting: false, unread: 0, unseen: true } });
    assert.equal(attentionMark(gaveUp)?.glyph, '❗');
    assert.equal(tabTitle(gaveUp, 'apex'), '❗ apex');
  });

  it('leaves a session that is still being told to carry on to get on with it', () => {
    // It has an attempt coming, so it is not waiting for anybody yet.
    const retrying = run({ stalled: { reason: 'rate_limit', since: '', nextTry: '2026-09-11T14:00:00Z', tries: 2 } });
    assert.equal(attentionMark(retrying), null);
  });

  it('marks a busy session in both, and asks nothing of anyone for it', () => {
    const busy = run({ agentStatus: 'working' });
    assert.equal(sessionMark(busy)?.glyph, '●', 'the same character the tab carries');
    assert.equal(tabTitle(busy, 'apex'), '● apex');
    // It will finish on its own, so it is not what the lists sort to the top.
    assert.equal(attentionMark(busy), null);
  });

  it('leaves an idle, read session unmarked in both', () => {
    assert.equal(attentionMark(run({})), null);
    assert.equal(sessionMark(run({})), null);
    assert.equal(tabTitle(run({}), 'apex'), 'apex');
  });

  it('shows a session working through subagents as working, not as finished', () => {
    const sub: SessionWork = { id: 'a1', kind: 'subagent', label: 'general-purpose', since: '', lastSeen: '' };
    const r = run({ agentStatus: 'idle', work: [sub] });
    assert.equal(sessionMark(r)?.tone, 'delegating');
    assert.equal(attentionMark(r), null, 'it is working; it is not asking for anybody');
    assert.equal(tabTitle(r, 'apex'), `${sessionMark(r)!.glyph} apex`, 'the tab says the same thing');
  });

  it('marks a session that is idle but still holding a background task open', () => {
    const shell: SessionWork = { id: 'b1', kind: 'shell', label: 'npm run dev', since: '', lastSeen: '' };
    assert.equal(sessionMark(run({ agentStatus: 'idle', work: [shell] }))?.tone, 'background');
  });

  it('lets what the operator is asked for win over what is running', () => {
    const sub: SessionWork = { id: 'a1', kind: 'subagent', label: null, since: '', lastSeen: '' };
    const r = run({ agentStatus: 'waiting', attention: { waiting: true, unread: 0, unseen: false }, work: [sub] });
    assert.equal(sessionMark(r)?.tone, 'blocked');
  });

  it('gives every state the tab shows a tone the web can colour', () => {
    const states: Array<Partial<Run>> = [
      { agentStatus: 'waiting', attention: { waiting: true, unread: 0, unseen: false } },
      { attention: { waiting: false, unread: 1, unseen: false } },
      { attention: { waiting: false, unread: 0, unseen: true } },
      { agentStatus: 'working' },
      { agentStatus: 'limited' },
      { agentStatus: 'idle', work: [{ id: 'a1', kind: 'subagent', label: null, since: '', lastSeen: '' }] },
      { agentStatus: 'idle', work: [{ id: 'b1', kind: 'shell', label: null, since: '', lastSeen: '' }] },
    ];
    const tones = states.map((s) => sessionMark(run(s))!.tone);
    assert.equal(new Set(tones).size, states.length, 'each state is its own tone, or two would look alike');
  });
});

describe('how a session is moved to another subscription', () => {
  const live = { hotSwapOn: true, privateCopy: true, attached: true, running: true };
  it('moves a running session on its own copy of its login in place', () => {
    assert.equal(swapMethod(live), 'hot');
  });

  it('restarts it when there is no copy to rewrite, or no process reading one', () => {
    assert.equal(swapMethod({ ...live, privateCopy: false }), 'restart', 'started before hot swap, or on macOS');
    assert.equal(swapMethod({ ...live, attached: false }), 'restart', 'no terminal attached');
    assert.equal(swapMethod({ ...live, running: false }), 'restart', 'its claude is gone');
  });

  it('restarts it when hot swap is off, or when it was to come back in a new terminal anyway', () => {
    assert.equal(swapMethod({ ...live, hotSwapOn: false }), 'restart');
    assert.equal(swapMethod({ ...live, fresh: true }), 'restart');
  });
});

describe('a session another agent started, and the task it was handed', () => {
  it('is left alone once it shows any sign of a turn: the channel got the task through', () => {
    for (const agentStatus of ['working', 'idle', 'waiting', 'limited']) {
      assert.equal(handoffDecision({ agentStatus, promptSinceMs: 60_000, waitedMs: 60_000 }), 'taken', agentStatus);
    }
  });

  it('is told where its task is once its prompt has sat idle: the spec-0464 case', () => {
    // Joined, sent the task a millisecond later, and never did a thing: still "starting", prompt on screen.
    assert.equal(handoffDecision({ agentStatus: 'starting', promptSinceMs: HANDOFF_GRACE_MS, waitedMs: 30_000 }), 'type');
    assert.equal(handoffDecision({ agentStatus: undefined, promptSinceMs: HANDOFF_GRACE_MS + 1, waitedMs: 30_000 }), 'type', 'no agent row yet');
  });

  it('waits while it is still starting, or its prompt has only just appeared', () => {
    assert.equal(handoffDecision({ agentStatus: 'starting', promptSinceMs: null, waitedMs: 5_000 }), 'wait', 'a startup dialog, or loading');
    assert.equal(handoffDecision({ agentStatus: 'starting', promptSinceMs: 2_000, waitedMs: 5_000 }), 'wait', 'the channel may be about to start a turn');
  });

  it('gives up, and says so, on a session that never reaches its prompt', () => {
    assert.equal(handoffDecision({ agentStatus: 'starting', promptSinceMs: null, waitedMs: HANDOFF_GIVE_UP_MS }), 'give-up');
  });

  it('points it at the message rather than retyping the task, which can run to pages', () => {
    const text = handoffPrompt('spec-0488', 5020);
    assert.match(text, /spec-0488/);
    assert.match(text, /#5020/);
    assert.match(text, /sb_inbox/);
    assert.ok(!text.includes('\n'), 'one line: a newline typed into the prompt would send half of it');
  });
});

describe('which run a hook belongs to', () => {
  it('goes by the conversation: a run already on it owns it, whatever the header says', () => {
    // The header is SWITCHBOARD_RUN_ID out of the environment, and a background job inherits the
    // environment of whichever session first started Claude Code's daemon for that profile.
    assert.equal(hookOwner({ headerRunId: 'first-session', sessionOwner: 'mine', parkedOwner: null }), 'mine');
  });

  it('then by the run whose own process moved that conversation into a background job', () => {
    assert.equal(hookOwner({ headerRunId: 'first-session', sessionOwner: null, parkedOwner: 'mine' }), 'mine');
  });

  it('and only then by the header, which is what an ordinary session has', () => {
    assert.equal(hookOwner({ headerRunId: 'mine', sessionOwner: null, parkedOwner: null }), 'mine');
  });

  it('leaves a conversation nothing claims to nobody', () => {
    assert.equal(hookOwner({ headerRunId: null, sessionOwner: null, parkedOwner: null }), null);
  });

  it('prefers the conversation over a job somebody else parked under the same id', () => {
    assert.equal(hookOwner({ headerRunId: 'stale', sessionOwner: 'mine', parkedOwner: 'other' }), 'mine');
  });
});
