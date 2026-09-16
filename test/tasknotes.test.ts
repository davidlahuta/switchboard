import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { finishedTasks, TaskNotes } from '../src/daemon/tasknotes.ts';

const note = (id: string, status: string): string =>
  JSON.stringify({
    type: 'attachment',
    attachment: {
      prompt: `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>C:\t\${id}.output</output-file>\n<status>${status}</status>\n<summary>Background command "x" ${status}</summary>\n</task-notification>`,
    },
  }) + '\n';

describe('finishedTasks', () => {
  it('reads the ids of background tasks the transcript says are over', () => {
    assert.deepEqual(finishedTasks(note('bjun0imhh', 'completed') + note('b2', 'failed') + note('b3', 'killed')), ['bjun0imhh', 'b2', 'b3']);
  });

  it('ignores a task that is still running and text that only mentions an id', () => {
    assert.deepEqual(finishedTasks(note('b1', 'running') + JSON.stringify({ text: 'waiting on <task-id>b9</task-id> <status>completed</status>' })), []);
  });
});

describe('TaskNotes', () => {
  it('reads only what a transcript gained, and a half-written line once it is whole', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notes-')), 't.jsonl');
    const notes = new TaskNotes();
    fs.writeFileSync(file, note('a1', 'completed'));
    assert.deepEqual(notes.finished(file), ['a1']);
    assert.deepEqual(notes.finished(file), []);
    const next = note('a2', 'completed');
    fs.appendFileSync(file, next.slice(0, 40));
    assert.deepEqual(notes.finished(file), []);
    fs.appendFileSync(file, next.slice(40));
    assert.deepEqual(notes.finished(file), ['a2']);
    assert.deepEqual(notes.finished(path.join(path.dirname(file), 'missing.jsonl')), []);
  });
});
