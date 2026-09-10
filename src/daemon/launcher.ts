import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_PATH, IS_WINDOWS } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('launcher');

export interface TerminalSpec {
  title: string;
  cwd: string;
  /** Arguments for the switchboard CLI (e.g. ['run', '--run-id', id]). */
  args: string[];
}

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
  /** All Switchboard tabs go into one named Windows Terminal window. */
  readonly windowName = process.env.SWITCHBOARD_WT_WINDOW ?? 'switchboard';

  get available(): boolean {
    return IS_WINDOWS || process.platform === 'darwin';
  }

  openTerminal(spec: TerminalSpec): void {
    const node = process.execPath;
    const cwd = fs.existsSync(spec.cwd) ? spec.cwd : process.cwd();
    if (IS_WINDOWS && this.wtPath) {
      // Windows Terminal treats ';' as a command separator.
      const esc = (s: string): string => s.replace(/;/g, '\\;');
      const args = ['-w', this.windowName, 'new-tab', '--title', esc(spec.title), '--suppressApplicationTitle', '-d', esc(cwd), esc(node), esc(CLI_PATH), ...spec.args.map(esc)];
      log.info('opening Windows Terminal tab', { title: spec.title, cwd });
      spawn(this.wtPath, args, { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    if (IS_WINDOWS) {
      const quote = (s: string): string => `"${s}"`;
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
