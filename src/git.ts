import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { IS_WINDOWS } from './config.ts';

const run = promisify(execFile);

export interface RepoInfo {
  /** Main worktree directory: the group key shared by all linked worktrees. */
  root: string;
  /** Worktree containing the directory (equals root for the main worktree). */
  worktree: string;
  branch: string | null;
  isGit: boolean;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { info: RepoInfo; at: number }>();
/**
 * Lookups already running, so a directory nobody has seen before costs one git process however many
 * agents ask about it at once. Without this, six sessions hitting one new path on the same tick each
 * pay for their own.
 */
const inflight = new Map<string, Promise<RepoInfo>>();

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/**
 * Where `dir` sits in git: its main worktree (the group key every linked worktree shares), the
 * worktree containing it, and the branch.
 *
 * Asynchronous on purpose. This shells out, and git can take seconds on a repo whose object store
 * is being repacked or whose disk is saturated — done synchronously that would block the daemon's
 * event loop, so one busy repository would stall every session's hooks, the web UI and the sockets
 * together. Answered from a short-lived cache the rest of the time.
 */
export async function resolveRepo(dir: string): Promise<RepoInfo> {
  const key = pathKey(dir);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const running = inflight.get(key);
  if (running) return running;

  const pending = (async (): Promise<RepoInfo> => {
    let info: RepoInfo = { root: path.resolve(dir), worktree: path.resolve(dir), branch: null, isGit: false };
    const out = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
    if (out) {
      const [common, top] = out.split(/\r?\n/);
      const root = path.basename(common) === '.git' ? path.dirname(common) : common;
      const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      info = {
        root: path.resolve(root),
        worktree: path.resolve(top ?? root),
        branch: branch || null,
        isGit: true,
      };
    }
    cache.set(key, { info, at: Date.now() });
    return info;
  })().finally(() => inflight.delete(key));

  inflight.set(key, pending);
  return pending;
}

export function forgetRepoCache(dir: string): void {
  cache.delete(pathKey(dir));
  inflight.delete(pathKey(dir));
}

export function repoIdFor(root: string): string {
  return crypto.createHash('sha1').update(pathKey(root)).digest('hex').slice(0, 12);
}

/** Repo-relative, forward-slash path of `file` inside `worktree`, or null when outside it. */
export function relPath(worktree: string, file: string): string | null {
  const rel = path.relative(worktree, path.resolve(worktree, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function normPattern(p: string): string {
  let out = p.trim().replace(/\\/g, '/');
  if (out.startsWith('./')) out = out.slice(2);
  return IS_WINDOWS ? out.toLowerCase() : out;
}

const GLOB_CHARS = /[*?[\]{}]/;

/** Does repo-relative `rel` fall under `pattern` (a path, a directory, or a glob)? */
export function matchesPattern(rel: string, pattern: string): boolean {
  const file = IS_WINDOWS ? rel.toLowerCase() : rel;
  const pat = normPattern(pattern);
  if (!pat) return false;
  if (!GLOB_CHARS.test(pat)) {
    const dir = pat.endsWith('/') ? pat : `${pat}/`;
    return file === pat.replace(/\/$/, '') || file.startsWith(dir);
  }
  return path.posix.matchesGlob(file, pat);
}

/** Do two patterns (paths or globs) plausibly overlap? Used for claim-vs-claim checks. */
export function patternsOverlap(a: string, b: string): boolean {
  const pa = normPattern(a);
  const pb = normPattern(b);
  const litA = pa.split(GLOB_CHARS)[0];
  const litB = pb.split(GLOB_CHARS)[0];
  return litA.startsWith(litB) || litB.startsWith(litA);
}
