import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_PATH, IS_WINDOWS } from '../config.ts';
import { logger } from '../log.ts';
import { keepFocus } from './focus.ts';

const log = logger('launcher');

export interface TerminalSpec {
  title: string;
  cwd: string;
  /** Arguments for the switchboard CLI (e.g. ['run', '--run-id', id]). */
  args: string[];
  /**
   * Windows Terminal window to open the tab in. '0' is the one you were last using, which is
   * created if there is none; a name keeps Switchboard's tabs together in a window of their own;
   * 'new' is always a window of its own, which is how a session escapes a window that has stopped
   * starting processes. See RunManager.openTerminalFor.
   */
  window?: string;
  /**
   * Open a plain console instead, even where Windows Terminal is installed. The last resort for a
   * session whose tabs keep opening empty: it gives up tabs, the title and the grouping, and in
   * exchange it depends on nothing but the shell. See RunManager's ESCAPES.
   */
  withoutWindowsTerminal?: boolean;
}

/**
 * How long apart Windows Terminal is asked for tabs.
 *
 * `wt.exe` is a messenger: it hands the request to the window that already exists and exits
 * immediately, so restarting the whole desk fires every request inside a few milliseconds and that
 * one window has to build nine pseudo-terminals at once. On 2026-09-22 it stopped building them at
 * all — the tab appeared, no process was ever started in it, and `wt` still exited 0 — and six
 * sessions lost their terminal in the same second with nothing to say so. Spacing the requests
 * keeps each one small enough for the window to answer.
 */
const TAB_GAP_MS = Number(process.env.SWITCHBOARD_TAB_GAP_MS ?? 700);

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      // lstat, not exists: Store apps like wt.exe are app-execution-alias reparse points that
      // fs.existsSync reports as missing.
      fs.lstatSync(candidate);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

/** Opens new terminal windows/tabs running the switchboard CLI. */
export class Launcher {
  readonly wtPath: string | null = IS_WINDOWS ? findOnPath('wt.exe') : null;
  /**
   * Windows Terminal window for session tabs when the caller does not name one. '0' means the
   * window you were last using; Windows Terminal opens one if there is none.
   */
  readonly windowName = process.env.SWITCHBOARD_WT_WINDOW ?? '0';

  get available(): boolean {
    return IS_WINDOWS || process.platform === 'darwin';
  }

  /** Tail of the queue that keeps Windows Terminal requests TAB_GAP_MS apart; see TAB_GAP_MS. */
  private pending: Promise<void> = Promise.resolve();

  openTerminal(spec: TerminalSpec): void {
    if (!IS_WINDOWS || !this.wtPath || spec.withoutWindowsTerminal) {
      this.spawnTerminal(spec);
      return;
    }
    this.pending = this.pending.then(async () => {
      this.spawnTerminal(spec);
      await new Promise((resolve) => setTimeout(resolve, TAB_GAP_MS));
    });
  }

  private spawnTerminal(spec: TerminalSpec): void {
    const node = process.execPath;
    const cwd = fs.existsSync(spec.cwd) ? spec.cwd : process.cwd();
    if (IS_WINDOWS && this.wtPath && !spec.withoutWindowsTerminal) {
      // Windows Terminal treats ';' as a command separator.
      const esc = (s: string): string => s.replace(/;/g, '\\;');
      // Deliberately not --suppressApplicationTitle: the runner sets the title itself, so renaming
      // a session reaches its tab instead of leaving the name it was opened with.
      const args = ['-w', spec.window ?? this.windowName, 'new-tab', '--title', esc(spec.title), '-d', esc(cwd), esc(node), esc(CLI_PATH), ...spec.args.map(esc)];
      log.info('opening Windows Terminal tab', { title: spec.title, cwd, window: spec.window ?? this.windowName });
      const wt = this.wtPath;
      // Windows Terminal brings its window to the front for every new tab; see keepFocus.
      keepFocus(() => {
        const child = spawn(wt, args, { detached: true, stdio: 'ignore' });
        /*
         * wt exiting 0 says only that the request was delivered, never that a process started in
         * the tab — that is what RunManager.openTerminalFor waits for. A non-zero exit or a spawn
         * error is the one failure visible from here, so it is at least said out loud.
         */
        child.on('error', (err) => log.error('could not run Windows Terminal', { title: spec.title, error: err.message }));
        child.on('exit', (code) => {
          if (code) log.warn('Windows Terminal refused a tab', { title: spec.title, code });
        });
        child.unref();
      }, `opening ${spec.title}`);
      return;
    }
    if (IS_WINDOWS) {
      const quote = (s: string): string => `"${s}"`;
      log.info('opening a console window', { title: spec.title, cwd, why: spec.withoutWindowsTerminal ? 'Windows Terminal is not starting processes' : 'Windows Terminal is not installed' });
      const cmdline = ['start', quote(spec.title), '/D', quote(cwd), quote(node), quote(CLI_PATH), ...spec.args.map(quote)].join(' ');
      spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', cmdline], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      return;
    }
    if (process.platform === 'darwin') {
      const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
      const command = `cd ${sh(cwd)} && ${[node, CLI_PATH, ...spec.args].map(sh).join(' ')}`;
      spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return;
    }
    throw new Error('Opening terminals is implemented for Windows Terminal and macOS Terminal. Run `switchboard run` in a terminal yourself.');
  }
}
