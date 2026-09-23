import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mouseEncodingSequence, TermMirror } from '../src/daemon/mirror.ts';
import type { TermServerFrame } from '../src/shared/types.ts';

/** What a viewer that opens the terminal now is sent first. */
const snapshotOf = (mirror: TermMirror): Promise<string> =>
  new Promise((resolve) => {
    const detach = mirror.attach((frame: TermServerFrame) => {
      if (frame.type === 'snapshot') {
        detach();
        resolve(frame.data);
      }
    });
  });

describe('what a web viewer is told about the mouse when it joins mid-session', () => {
  it('asks for the wheel in the format Claude Code asked for it at startup', async () => {
    // The full-screen renderer: alternate screen, every mouse event, SGR encoding — sent once.
    const mirror = new TermMirror(80, 24);
    mirror.write('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[Hconversation');
    const data = await snapshotOf(mirror);
    assert.match(data, /\x1b\[\?1003h/, 'which events');
    assert.match(data, /\x1b\[\?1006h/, 'and how: without this the wheel arrives in a format the session does not read');
    mirror.dispose();
  });

  it('asks for nothing it was not asked for: the plain renderer scrolls the terminal itself', async () => {
    const mirror = new TermMirror(80, 24);
    mirror.write('● Reading the file\r\n❯ ');
    const data = await snapshotOf(mirror);
    assert.doesNotMatch(data, /\x1b\[\?100[036]h/);
    mirror.dispose();
  });

  it('follows a program that turns the encoding off again', async () => {
    const mirror = new TermMirror(80, 24);
    mirror.write('\x1b[?1000h\x1b[?1006h');
    mirror.write('\x1b[?1006l');
    assert.doesNotMatch(await snapshotOf(mirror), /\x1b\[\?1006h/);
    mirror.dispose();
  });

  it('names each encoding by the mode that selects it', () => {
    assert.equal(mouseEncodingSequence('SGR'), '\x1b[?1006h');
    assert.equal(mouseEncodingSequence('SGR_PIXELS'), '\x1b[?1016h');
    assert.equal(mouseEncodingSequence('DEFAULT'), '');
    assert.equal(mouseEncodingSequence(undefined), '', 'an xterm that no longer exposes it: no worse than before');
  });
});

describe('what counts as a terminal host running old code', () => {
  it('is the runner and what it imports, not the daemon or the web UI', async () => {
    const { runnerSourceFiles } = await import('../src/daemon/source.ts');
    const files = runnerSourceFiles().map((f) => f.split('\\').join('/'));
    assert.ok(files.some((f) => f.endsWith('src/runner/runner.ts')));
    assert.ok(files.some((f) => f.endsWith('src/shared/protocol.ts')), 'the protocol it speaks to the daemon counts');
    assert.ok(!files.some((f) => /src\/daemon\//.test(f)), 'a daemon fix does not make every session "old host"');
    assert.ok(!files.some((f) => /\/web\//.test(f)));
  });
});
