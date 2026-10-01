import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { withoutParentSession } from '../config.ts';
import { resolveRepo } from '../git.ts';
import { logger } from '../log.ts';
import { type DeskRepo, remoteKey } from '../shared/desk.ts';

const log = logger('clone');
const execFileP = promisify(execFile);

/** Remotes a desk will clone: https, ssh and scp-style. Never a local path or a file:// URL. */
export function cloneableUrl(url: string): boolean {
  return /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(url);
}

/**
 * Clone a repository into `root`. A folder of that name that already exists gets a suffix rather
 * than being cloned over: nothing that is on the desk already is ever touched. `env` carries what
 * git needs to authenticate (see the credential helper), and never a prompt: a clone nobody is
 * watching must fail rather than wait for a password.
 */
export async function cloneRepo(url: string, root: string, opts: { name?: string | null; env?: Record<string, string> | null } = {}): Promise<DeskRepo> {
  if (!cloneableUrl(url)) throw new Error(`refusing to clone ${url}: only https, ssh and git@ remotes`);
  fs.mkdirSync(root, { recursive: true });
  const base = (opts.name || remoteKey(url)?.split('/').pop() || 'repo').replace(/[^A-Za-z0-9._-]/g, '-');
  let dir = path.join(root, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${base}-${i}`);
  log.info('cloning', { url: url.replace(/\/\/[^@/]+@/, '//'), into: dir });
  try {
    await execFileP('git', ['clone', url, dir], {
      windowsHide: true,
      timeout: 30 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...withoutParentSession(), ...(opts.env ?? {}), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    const e = err as { stderr?: string; message?: string };
    throw new Error(`git clone failed: ${(e.stderr || e.message || '').trim().split('\n').slice(-3).join(' ')}`);
  }
  const info = await resolveRepo(dir);
  return { path: dir, remoteKey: remoteKey(url), remoteUrl: url, name: path.basename(dir), branch: info.branch };
}
