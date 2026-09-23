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

describe('how far back a viewer can scroll when it opens a session', () => {
  it('gets thousands of lines of a plain-renderer session, not the last few hundred', async () => {
    const mirror = new TermMirror(80, 24);
    for (let i = 1; i <= 3000; i++) mirror.write(`line ${i}\r\n`);
    const data = await snapshotOf(mirror);
    assert.match(data, /line 1\b/, 'the first of 3000 lines is still there to scroll back to');
    assert.match(data, /line 3000\b/);
    mirror.dispose();
  });
});

describe('a session’s screen history across a daemon restart', () => {
  const fsMod = () => import('node:fs');
  const tmpLog = async (): Promise<string> => {
    const [{ default: fs }, { default: os }, { default: path }] = await Promise.all([fsMod(), import('node:os'), import('node:path')]);
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-screen-')), 'run.log');
  };

  it('is rebuilt from what the session printed before the restart', async () => {
    const log = await tmpLog();
    const before = new TermMirror(80, 24, log);
    for (let i = 1; i <= 1200; i++) before.write(`turn ${i}\r\n`);
    before.dispose(); // the daemon going down
    const after = new TermMirror(80, 24, log);
    after.write('after the restart\r\n');
    const data = await snapshotOf(after);
    assert.match(data, /turn 1\b/, 'scrolled back past the restart to the start');
    assert.match(data, /after the restart/);
    after.dispose(true);
  });

  it('keeps the full-screen renderer’s modes too, so a viewer after a restart can still scroll it', async () => {
    const log = await tmpLog();
    const before = new TermMirror(80, 24, log);
    before.write('\x1b[?1049h\x1b[?1003h\x1b[?1006h');
    before.dispose();
    const after = new TermMirror(80, 24, log);
    const data = await snapshotOf(after);
    assert.match(data, /\x1b\[\?1003h/);
    assert.match(data, /\x1b\[\?1006h/);
    after.dispose(true);
  });

  it('starts over for a new process, and is deleted with the session', async () => {
    const { default: fs } = await fsMod();
    const log = await tmpLog();
    const mirror = new TermMirror(80, 24, log);
    mirror.write('old process\r\n');
    mirror.reset();
    mirror.write('new process\r\n');
    mirror.dispose();
    const again = new TermMirror(80, 24, log);
    const data = await snapshotOf(again);
    assert.doesNotMatch(data, /old process/);
    assert.match(data, /new process/);
    again.dispose(true);
    assert.equal(fs.existsSync(log), false);
  });

  it('stays bounded: a log past its limit keeps its most recent part, from a line start', async () => {
    const { default: fs } = await fsMod();
    const log = await tmpLog();
    const mirror = new TermMirror(80, 24, log);
    const line = 'x'.repeat(1000) + '\r\n';
    for (let i = 0; i < 9000; i++) mirror.write(line); // about 9 MB
    mirror.write('the very end\r\n');
    const size = fs.statSync(log).size;
    assert.ok(size <= 8 * 1024 * 1024, `cut back, at ${size} bytes`);
    assert.ok(fs.readFileSync(log, 'utf8').startsWith('x'), 'starts at the beginning of a line');
    assert.match(fs.readFileSync(log, 'utf8'), /the very end/);
    mirror.dispose(true);
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
