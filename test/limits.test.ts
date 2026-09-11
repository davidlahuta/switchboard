import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanForLimit, scopedBinds } from '../src/shared/limits.ts';

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

describe('a weekly window scoped to one model', () => {
  it('binds a session that runs that model', () => {
    assert.equal(scopedBinds('Fable', 'claude-fable-5-1'), true);
    assert.equal(scopedBinds('Opus', 'claude-opus-5'), true);
  });

  it('leaves every other session alone', () => {
    // The account-wide week counts all models; this one is a second ceiling under it. A session on
    // Sonnet has the whole seven-day allowance in front of it whatever Fable has spent.
    assert.equal(scopedBinds('Fable', 'claude-sonnet-5'), false);
    assert.equal(scopedBinds('Opus', 'claude-haiku-4-5-20251001'), false);
  });

  it('holds nothing against a session whose model is not known', () => {
    // It might be on that model; the account-wide windows are what we actually know, and stranding
    // a session on a guess costs more than moving it again if the guess was wrong.
    assert.equal(scopedBinds('Fable', null), false);
  });

  it('reads a display name with more than the family in it', () => {
    assert.equal(scopedBinds('Claude Fable 5.1', 'claude-fable-5-1'), true);
    assert.equal(scopedBinds('Claude Fable 5.1', 'claude-opus-5'), false);
  });

  it('binds nothing when the scope names no model at all', () => {
    // Some scoped limits are about a surface rather than a model.
    assert.equal(scopedBinds('scoped', 'claude-opus-5'), false);
  });
});

describe('the ceilings that are not windows', () => {
  it('reads the spend cap that stopped a session overnight', () => {
    // Verbatim from the screen of a session that sat idle from 01:10 to 07:10 with full windows:
    // nothing in it matched, so Switchboard never knew it had stopped.
    const screen = "  ⎿  You've hit your monthly spend limit · your session limit resets 2:40am (Europe/Prague)\n";
    const found = scanForLimit(screen);
    assert.equal(found.kind, 'limit');
    assert.equal(found.kind === 'limit' && found.cause, 'spend');
  });

  it('tells a spend cap apart from a window, because only one of them can be checked', () => {
    const window = scanForLimit('  Usage limit reached · resets at 4:00 AM\n');
    assert.equal(window.kind === 'limit' && window.cause, 'window');
  });

  it('still reads the wording it always did', () => {
    assert.equal(scanForLimit("  You've hit your 5-hour limit\n").kind, 'limit');
    assert.equal(scanForLimit('  weekly limit reached\n').kind, 'limit');
  });

  it('does not take an agent quoting the error as the session being stopped', () => {
    const screen = '2026-09-11T01:10:00.000Z WARN [runs] usage limit reached · monthly spend limit\n';
    assert.equal(scanForLimit(screen).kind, 'ignored');
  });
});
