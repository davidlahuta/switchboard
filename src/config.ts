import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';

export const PORT = Number(process.env.SWITCHBOARD_PORT ?? 4477);
/**
 * Loopback is always bound: hooks, MCP shims and session runners all reach the daemon at
 * 127.0.0.1. SWITCHBOARD_BIND adds further addresses (comma-separated), e.g. your Tailscale IP,
 * for direct remote access without `tailscale serve`. Requests arriving that way are not treated
 * as local, so they still need a paired device.
 */
export const BIND_HOSTS: string[] = [
  '127.0.0.1',
  ...(process.env.SWITCHBOARD_BIND ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
].filter((h, i, all) => all.indexOf(h) === i);
export const DAEMON_URL = process.env.SWITCHBOARD_URL ?? `http://127.0.0.1:${PORT}`;
export const DAEMON_WS = DAEMON_URL.replace(/^http/, 'ws');

const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share');
export const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR ?? path.join(localAppData, 'switchboard');
export const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
export const RUNTIME_DIR = path.join(DATA_DIR, 'runtime');
/*
 * Where a `claude` we run for our own purposes — a version check, an auth probe, an update — is
 * started. Left alone such a process inherits the daemon's own working directory, and the daemon is
 * launched from a logon task with no working directory set, which on Windows means C:\Windows\System32.
 * Claude Code then reports that as its cwd, and a session that only ever fires one SessionEnd hook
 * registers itself on the board as an agent in a repository called System32.
 */
export const SPAWN_CWD = DATA_DIR;

/**
 * What a Claude Code session stamps on every process it launches: which session it is, how to talk
 * back to it, and the marker saying that whatever you are, you are a child of it.
 */
const PARENT_SESSION_ENV = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  /*
   * Switchboard's own mark, and the most dangerous one to inherit.
   *
   * The hooks carry it as a header, and the daemon reads that header as "this run is speaking". It
   * is inherited like anything else, so a daemon that happened to be started from inside a hosted
   * session — `npm run daemon` from that session's own shell, which is how Switchboard is developed
   * — carries that session's run id, and hands it to every claude it runs for its own purposes.
   * `claude update` and `claude mcp list` each open a session of their own for a second and fire a
   * lone SessionEnd on the way out, under a fresh conversation id and that borrowed run id, which
   * the run then adopted as its own. A $145 conversation stopped being reachable that way while its
   * transcript sat untouched on disk; see rebindDecision for the other half of the fix.
   */
  'SWITCHBOARD_RUN_ID',
]);

/**
 * What the terminal a process was launched from says about itself.
 *
 * None of it describes the terminal a hosted session actually runs in, which is a pseudo-terminal
 * the runner makes on the spot. Claude Code sets NO_COLOR=1 on everything it launches, so a daemon
 * started from inside a session hands that down, and every session it opens renders in black and
 * white — correctly, on the strength of a variable that was describing somebody else's terminal.
 */
const PARENT_TERMINAL_ENV = new Set(['TERM', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE']);

/**
 * The environment with a launching session's fingerprints wiped off it.
 *
 * A session Switchboard hosts is nobody's child. It owns its own conversation, and its transcript is
 * the only thing a swap, a restart or a resume has to come back to — Claude Code exits with "No
 * conversation found" when asked to resume a session that never wrote one, and Switchboard falls
 * back to starting a fresh session under the same id, which reads as the conversation vanishing.
 *
 * Claude Code turns transcript saving off for a session carrying CLAUDE_CODE_CHILD_SESSION. So a
 * daemon that happened to be started from inside a Claude Code session — which is exactly what
 * developing Switchboard from inside Switchboard leads to — hands that marker down through the
 * runner to every session it launches, and their conversations quietly stop being resumable. Strip
 * it wherever we start claude ourselves, rather than trusting how the daemon came to be running.
 */
export function withoutParentSession(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && !PARENT_SESSION_ENV.has(k) && !PARENT_TERMINAL_ENV.has(k)) out[k] = v;
  }
  return out;
}

/**
 * The terminal variables for the pseudo-terminal the runner is about to create, which is the only
 * terminal the session will ever be looking at. Set rather than inherited, so how the daemon
 * happened to be started cannot decide whether sessions come out in colour.
 */
export const PTY_TERM: Record<string, string> = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
export const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

/** The user's regular Claude Code config dir: the "default" subscription and the shared source. */
export const HOME_CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const HOME_CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
export const CLI_PATH = path.join(PACKAGE_ROOT, 'src', 'cli.ts');
export const WEB_DIST = path.join(PACKAGE_ROOT, 'web', 'dist');

export const IS_WINDOWS = process.platform === 'win32';

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, PROFILES_DIR, RUNTIME_DIR]) fs.mkdirSync(dir, { recursive: true });
}

/** Command line that re-invokes this CLI with the current Node binary. */
export function selfCommand(...args: string[]): { command: string; args: string[] } {
  return { command: process.execPath, args: [CLI_PATH, ...args] };
}
