import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanForLimit } from '../src/shared/limits.ts';

describe('reading a usage limit off a screen', () => {
  it('reads the banner Claude Code draws', () => {
    const screen = ['● Running the recipe…', '', '  Usage limit reached · resets at 4:00 AM', ''].join('\n');
    const found = scanForLimit(screen);
    assert.equal(found.kind, 'limit');
  });

  it('ignores a log line the session printed itself', () => {
    // Verbatim from the morning this was written: a session grepping the daemon's own log reported
    // itself out of usage, and the label stuck to it in the UI.
    const screen =
      '2026-09-11T06:57:46.351Z WARN  [runs] usage limit {"run":"803c73e5","source":"pty","detail":"usage limit reached"}\n';
    const found = scanForLimit(screen);
    assert.equal(found.kind, 'ignored');
  });

  it('ignores the source code that defines the pattern', () => {
    const screen = "54:const LIMIT_RE =\n55:  /(usage limit reached|you've hit your limit)/i;\n";
    assert.equal(scanForLimit(screen).kind, 'ignored');
  });

  it('ignores prose about limits in a file the session is reading', () => {
    const screen = 'docs/ARCHITECTURE.md:12: a conversation that once hit a usage limit reached the banner\n';
    assert.equal(scanForLimit(screen).kind, 'ignored');
  });

  it('keeps reading past a line it dismissed', () => {
    // A session that greps a log and is then genuinely stopped must still be noticed.
    const screen = [
      '2026-09-11T06:57:46.351Z WARN  [runs] usage limit reached',
      '',
      '  Usage limit reached · resets at 4:00 AM',
      '',
    ].join('\n');
    const first = scanForLimit(screen);
    assert.equal(first.kind, 'ignored');
    const rest = screen.slice(first.kind === 'ignored' ? first.restFrom : 0);
    assert.equal(scanForLimit(rest).kind, 'limit', 'the real banner below it still counts');
  });

  it('says nothing about an ordinary screenful', () => {
    assert.equal(scanForLimit('● Edited src/daemon/runs.ts\n  3 additions, 1 removal\n').kind, 'none');
  });
});
