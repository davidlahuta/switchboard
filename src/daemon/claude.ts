import fs from 'node:fs';
import path from 'node:path';
import { CLI_PATH, DAEMON_URL, IS_WINDOWS, RUNTIME_DIR, ensureDirs } from '../config.ts';

let claudePathCache: string | null | undefined;

/** Absolute path of the `claude` executable on PATH (or SWITCHBOARD_CLAUDE_PATH). */
export function findClaude(): string | null {
  if (claudePathCache !== undefined) return claudePathCache;
  const override = process.env.SWITCHBOARD_CLAUDE_PATH;
  if (override && fs.existsSync(override)) return (claudePathCache = override);
  const exts = IS_WINDOWS ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const ordered = IS_WINDOWS ? ['.exe', ...exts.filter((e) => e !== '.exe')] : exts;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ordered) {
      const candidate = path.join(dir, `claude${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return (claudePathCache = candidate);
      } catch {
        // not here
      }
    }
  }
  return (claudePathCache = null);
}

/** Command + args to run claude, going through cmd.exe for .cmd/.bat shims (npm installs). */
export function claudeCommand(claudePath: string, args: string[]): { file: string; args: string[] } {
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(claudePath)) {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', claudePath, ...args] };
  }
  return { file: claudePath, args };
}

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'Notification',
  'SessionEnd',
  'CwdChanged',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const EDIT_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

export function hookUrl(event: string): string {
  return `${DAEMON_URL}/hooks/${event}`;
}

export function isSwitchboardHookUrl(url: unknown): boolean {
  return typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/hooks\//.test(url);
}

/** The `hooks` block Switchboard needs, in Claude Code settings format. */
export function hooksConfig(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    // The run header lets the daemon follow a hosted session across /clear (which starts a new
    // session id in the same process). It is empty for sessions Switchboard did not launch.
    const hook = {
      type: 'http',
      url: hookUrl(event),
      timeout: event === 'SessionStart' ? 10 : 5,
      headers: { 'X-Switchboard-Run': '$SWITCHBOARD_RUN_ID' },
      allowedEnvVars: ['SWITCHBOARD_RUN_ID'],
    };
    const entry: Record<string, unknown> = { hooks: [hook] };
    if (event === 'PreToolUse') entry.matcher = EDIT_MATCHER;
    out[event] = [entry];
  }
  return out;
}

/** MCP server entry for the stdio shim. */
export function mcpServerEntry(env: Record<string, string> = {}): Record<string, unknown> {
  return { type: 'stdio', command: process.execPath, args: [CLI_PATH, 'mcp'], env };
}

export function writeRuntimeJson(name: string, data: unknown): string {
  ensureDirs();
  const file = path.join(RUNTIME_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** Claude Code's transcript folder name for a working directory. */
export function projectSlug(dir: string): string {
  return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Atomic-ish JSON write: temp file + rename. */
export function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
