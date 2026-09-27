import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { Bus } from '../src/daemon/bus.ts';
import { Coordinator } from '../src/daemon/coord.ts';
import { Db } from '../src/daemon/db.ts';
import { finishedTasks, notificationBlocks, subagentTranscript, transcriptFacts, TranscriptReader } from '../src/daemon/tasknotes.ts';
import { TranscriptWatch, turnStatus } from '../src/daemon/transcriptWatch.ts';

const line = (o: object): string => JSON.stringify(o) + '\n';
const block = (ids: string[], status: string | null, extra = ''): string =>
  `<task-notification>\n${ids.map((id) => `<task-id>${id}</task-id>`).join('\n')}\n${status ? `<status>${status}</status>\n` : ''}<summary>x</summary>${extra}\n</task-notification>`;
/** The three records Claude Code delivers a notification in, as measured in real transcripts. */
const queued = (ids: string[], status: string | null, at = '2026-09-27T10:00:00.000Z') =>
  line({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content: block(ids, status) });
const attached = (ids: string[], status: string | null, at = '2026-09-27T10:00:00.000Z') =>
  line({ type: 'attachment', timestamp: at, attachment: { type: 'queued_command', prompt: block(ids, status) } });
const delivered = (ids: string[], status: string | null, at = '2026-09-27T10:00:00.000Z') =>
  line({ type: 'user', timestamp: at, origin: { kind: 'task-notification' }, message: { role: 'user', content: block(ids, status) } });
const assistant = (at: string, content: object[] = [{ type: 'text', text: 'hi' }], extra: object = {}) =>
  line({ type: 'assistant', timestamp: at, message: { model: 'claude-opus-5-5', content }, ...extra });
const toolUse = (at: string, id: string, name: string, input: object) => assistant(at, [{ type: 'tool_use', id, name, input }]);
const toolResult = (at: string, id: string, result: unknown) =>
  line({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] }, toolUseResult: result });

describe('task notifications', () => {
  it('reads every id in a block, and a block at a time', () => {
    // Measured: a resume reports several lost agents in one block.
    assert.deepEqual(notificationBlocks(block(['a1', 'a2', 'a3'], 'stopped')), [{ ids: ['a1', 'a2', 'a3'], status: 'stopped' }]);
    // A monitor's event has no status; the next notification's must not be read as its.
    assert.deepEqual(notificationBlocks(block(['m1'], null) + block(['b1'], 'completed')), [
      { ids: ['m1'], status: null },
      { ids: ['b1'], status: 'completed' },
    ]);
  });

  it('finds the ends in each record a notification is delivered in, and nowhere else', () => {
    assert.deepEqual(finishedTasks(queued(['q1'], 'completed') + attached(['a1'], 'failed') + delivered(['d1'], 'killed')), ['q1', 'a1', 'd1']);
    // A tool result that prints a transcript, or text quoting the tags, is not a notification.
    const quoted = line({ type: 'user', message: { content: [{ type: 'tool_result', content: block(['x1'], 'completed') }] } });
    assert.deepEqual(finishedTasks(quoted + assistant('2026-09-27T10:00:00Z', [{ type: 'text', text: block(['x2'], 'completed') }])), []);
    assert.deepEqual(finishedTasks(queued(['r1'], 'running')), []);
  });
});

describe('what a transcript says', () => {
  it('starts work from the results that hand back a handle, and ends it from its notification', () => {
    const text =
      toolUse('2026-09-27T10:00:00Z', 't1', 'Bash', { command: 'verify.sh', description: 'Run the recipe', run_in_background: true }) +
      toolResult('2026-09-27T10:00:01Z', 't1', { stdout: '', backgroundTaskId: 'b1' }) +
      toolUse('2026-09-27T10:00:02Z', 't2', 'Monitor', { description: 'watch' }) +
      toolResult('2026-09-27T10:00:03Z', 't2', { taskId: 'm1', timeoutMs: 60000, persistent: false }) +
      queued(['m1'], null, '2026-09-27T10:00:30Z') +
      queued(['b1'], 'completed', '2026-09-27T10:05:00Z');
    const facts = transcriptFacts(text, 'S');
    const started = facts.filter((f) => f.type === 'started').map((f) => f.type === 'started' && `${f.kind}:${f.id}`);
    assert.deepEqual(started, ['shell:b1', 'monitor:m1']);
    assert.deepEqual(facts.filter((f) => f.type === 'seen').flatMap((f) => (f.type === 'seen' ? f.ids : [])), ['m1']);
    assert.deepEqual(facts.filter((f) => f.type === 'ended').flatMap((f) => (f.type === 'ended' ? f.ids : [])), ['b1']);
  });

  it('pairs a result with its call across two reads', () => {
    const reader = { pending: new Map(), oneShotCrons: new Set<string>() };
    transcriptFacts(toolUse('2026-09-27T10:00:00Z', 't1', 'Bash', { command: 'x' }), 'S', reader);
    const facts = transcriptFacts(toolResult('2026-09-27T10:00:01Z', 't1', { backgroundTaskId: 'b9' }), 'S', reader);
    assert.ok(facts.some((f) => f.type === 'started' && f.id === 'b9'));
  });

  it('reads where a turn is: working, over, or stopped with Esc', () => {
    const turns = (text: string) => transcriptFacts(text, 'S').flatMap((f) => (f.type === 'turn' ? [f.phase] : []));
    assert.deepEqual(turns(assistant('2026-09-27T10:00:00Z')), ['active']);
    assert.deepEqual(turns(line({ type: 'system', subtype: 'turn_duration', timestamp: '2026-09-27T10:00:00Z' })), ['ended']);
    // Measured: an Esc writes this and fires no hook at all.
    assert.deepEqual(turns(line({ type: 'user', timestamp: 't', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })), ['interrupted']);
    assert.deepEqual(turns(line({ type: 'user', timestamp: 't', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })), ['interrupted']);
    // A limit banner or API error is written as an assistant message nobody generated.
    assert.deepEqual(turns(assistant('t', undefined, { message: { model: '<synthetic>', content: [] } })), []);
    // A subagent's records say nothing about the main thread.
    assert.deepEqual(turns(assistant('t', undefined, { isSidechain: true })), []);
    // A loop waking the session starts a turn that no UserPromptSubmit announces.
    assert.deepEqual(turns(line({ type: 'system', subtype: 'scheduled_task_fire', timestamp: 't', content: 'Claude resuming /loop wakeup (Sep 27 9:46am)' })), ['active']);
  });

  it('takes a /loop wake-up off when it fires', () => {
    const text =
      toolUse('2026-09-27T10:00:00Z', 'w', 'ScheduleWakeup', { delaySeconds: 60, reason: 'poll' }) +
      toolResult('2026-09-27T10:00:01Z', 'w', { scheduledFor: Date.parse('2026-09-27T10:01:01Z'), clampedDelaySeconds: 60 }) +
      line({ type: 'system', subtype: 'scheduled_task_fire', timestamp: '2026-09-27T10:01:01Z', content: 'Claude resuming /loop wakeup' });
    const facts = transcriptFacts(text, 'S');
    assert.ok(facts.some((f) => f.type === 'started' && f.id === 'wake:S' && f.until === '2026-09-27T10:01:01.000Z'));
    assert.ok(facts.some((f) => f.type === 'ended' && f.ids.includes('wake:S')));
  });
});

describe('TranscriptReader', () => {
  it('reads only what a transcript gained, and a half-written line once it is whole', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notes-')), 't.jsonl');
    const reader = new TranscriptReader();
    const ended = (): string[] => reader.read(file, 'S').flatMap((f) => (f.type === 'ended' ? f.ids : []));
    fs.writeFileSync(file, queued(['a1'], 'completed'));
    assert.deepEqual(ended(), ['a1']);
    assert.deepEqual(ended(), []);
    const next = queued(['a2'], 'completed');
    fs.appendFileSync(file, next.slice(0, 40));
    assert.deepEqual(ended(), []);
    fs.appendFileSync(file, next.slice(40));
    assert.deepEqual(ended(), ['a2']);
    assert.deepEqual(reader.read(path.join(path.dirname(file), 'missing.jsonl'), 'S'), []);
  });

  it('knows where a subagent writes its own transcript', () => {
    assert.equal(subagentTranscript(path.join('p', 'abc.jsonl'), 'a1'), path.join('p', 'abc', 'subagents', 'agent-a1.jsonl'));
  });
});

describe('a status the transcript corrects', () => {
  it('moves only in the direction the record says, from the states it can be wrong in', () => {
    assert.equal(turnStatus('working', 'interrupted'), 'idle');
    assert.equal(turnStatus('waiting', 'ended'), 'idle');
    assert.equal(turnStatus('idle', 'ended'), null);
    assert.equal(turnStatus('idle', 'active'), 'working');
    assert.equal(turnStatus('limited', 'active'), 'working');
    assert.equal(turnStatus('working', 'active'), null);
    assert.equal(turnStatus('starting', 'active'), null);
  });
});

describe('TranscriptWatch', () => {
  let dir: string;
  let coord: Coordinator;
  const events: string[] = [];
  let watch: TranscriptWatch;

  before(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-watch-')));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    coord = new Coordinator(new Db(':memory:'), new Bus());
    watch = new TranscriptWatch(coord, {
      onWorkChanged: (s) => events.push(`changed:${s}`),
      onWorkSettled: (s) => events.push(`settled:${s}`),
      onIdle: (s) => events.push(`idle:${s}`),
    });
  });

  const session = async (id: string): Promise<string> => {
    await coord.registerAgent({ sessionId: id, cwd: dir, runId: null, subscriptionId: null });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, '');
    coord.setTranscript(id, file);
    return file;
  };
  const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

  it('shows a session stopped with Esc as idle, though no Stop hook came', async () => {
    const file = await session('esc');
    coord.setStatus('esc', 'working', 'Bash');
    watch.poll();
    fs.appendFileSync(file, line({ type: 'user', timestamp: soon(1000), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }));
    watch.poll();
    assert.equal(coord.agent('esc')?.status, 'idle');
    assert.ok(events.includes('idle:esc'), 'anything queued behind the turn is told');
  });

  it('shows a turn a notification started as working, though no prompt hook came', async () => {
    const file = await session('woken');
    coord.setStatus('woken', 'idle', null);
    watch.poll();
    fs.appendFileSync(file, delivered(['b1'], 'completed', soon(1000)) + assistant(soon(2000)));
    watch.poll();
    assert.equal(coord.agent('woken')?.status, 'working');
  });

  it('does not undo a hook with a record older than it', async () => {
    const file = await session('late');
    watch.poll();
    // The turn's last words are read after its Stop hook already said idle.
    fs.appendFileSync(file, assistant(new Date(Date.now() - 5000).toISOString()));
    coord.setStatus('late', 'idle', null);
    watch.poll();
    assert.equal(coord.agent('late')?.status, 'idle');
  });

  it('lists a monitor and a shell, ends the shell on its notification, and does not bring it back', async () => {
    const file = await session('bg');
    watch.poll();
    const t = soon(0);
    fs.appendFileSync(
      file,
      toolUse(t, 'u1', 'Bash', { command: 'verify.sh', description: 'Run the recipe' }) +
        toolResult(t, 'u1', { backgroundTaskId: 'bgshell' }) +
        toolUse(t, 'u2', 'Monitor', { description: 'watch' }) +
        toolResult(t, 'u2', { taskId: 'bgmon', timeoutMs: 600000, persistent: false }),
    );
    watch.poll();
    assert.deepEqual(coord.liveWork('bg').map((w) => w.kind).sort(), ['monitor', 'shell']);
    assert.ok(coord.liveWork('bg').find((w) => w.kind === 'monitor')?.until);
    fs.appendFileSync(file, queued(['bgshell'], 'completed', soon(1000)));
    watch.poll();
    assert.deepEqual(coord.liveWork('bg').map((w) => w.kind), ['monitor']);
    assert.ok(events.includes('settled:bg'));
    // The hook reporting the same start late must not reopen it.
    assert.equal(coord.workStarted('bg', { id: 'bgshell', kind: 'shell' }), false);
    assert.deepEqual(coord.liveWork('bg').map((w) => w.kind), ['monitor']);
  });

  it('ends a monitor once its timeout has passed, since nothing records that', async () => {
    await session('mon');
    coord.workStarted('mon', { id: 'oldmon', kind: 'monitor', until: new Date(Date.now() - 11 * 60_000).toISOString() });
    coord.sweep();
    assert.deepEqual(coord.liveWork('mon'), []);
  });

  it('keeps a shell far longer than the old forty-five minutes', async () => {
    await session('long');
    coord.workStarted('long', { id: 'longshell', kind: 'shell' });
    coord.sweep();
    assert.equal(coord.liveWork('long').length, 1);
  });
});
