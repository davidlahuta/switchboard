import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SPAWN_CWD, withoutParentSession } from '../config.ts';
import { findClaude } from '../daemon/claude.ts';
import type { DeskTools } from '../shared/desk.ts';
import { logger } from '../log.ts';

const run = promisify(execFile);
const log = logger('tools');

/**
 * Run a CLI for what it prints, or null when it is not there or fails. Never throws.
 *
 * Straight, without a shell, first: run through cmd.exe from the daemon's hidden, console-less
 * process, git and claude printed nothing at all. Only a name that is not an executable — az and npm
 * install .cmd shims — is tried again through the shell, which is the one way to run those.
 */
async function out(file: string, args: string[], timeout = 30_000): Promise<string | null> {
  const opts = { timeout, windowsHide: true, cwd: SPAWN_CWD, env: withoutParentSession() };
  const started = Date.now();
  try {
    const r = await run(file, args, opts);
    const text = String(r.stdout).trim();
    if (!text) log.debug('a tool printed nothing', { file, args, ms: Date.now() - started, stderr: String(r.stderr).slice(0, 300) });
    return text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || process.platform !== 'win32') return null;
  }
  try {
    return String((await run(file, args, { ...opts, shell: true })).stdout).trim();
  } catch {
    return null;
  }
}

/**
 * What this machine can do for a session: the CLIs a session leans on, and who they are logged in
 * as. Read-only — nothing here logs anything in or changes any configuration.
 */
export async function toolStatus(hasWindowsTerminal: boolean): Promise<DeskTools> {
  const claude = findClaude();
  const [claudeVersion, git, ghVersion, ghStatus, azAccount] = await Promise.all([
    claude ? out(claude, ['--version']) : Promise.resolve(null),
    out('git', ['--version']),
    out('gh', ['--version']),
    out('gh', ['api', 'user', '--jq', '.login']),
    out('az', ['account', 'show', '--query', 'user.name', '-o', 'tsv'], 15_000),
  ]);
  return {
    claude,
    claudeVersion: claudeVersion?.split(/\s+/)[0] ?? null,
    wt: hasWindowsTerminal,
    git: git?.replace(/^git version\s*/, '') ?? null,
    node: process.version,
    gh: { installed: ghVersion !== null, account: ghStatus || null },
    az: { installed: azAccount !== null || (await out('az', ['version', '-o', 'tsv'], 15_000)) !== null, account: azAccount || null },
  };
}
