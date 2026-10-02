import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
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
  /**
   * git could not say (a timeout on a busy machine, a locked index), as opposed to saying "not a
   * repository". Nothing about where the directory belongs can be concluded from such an answer.
   */
  failed?: boolean;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { info: RepoInfo; at: number }>();
/**
 * Lookups already running, so a directory nobody has seen before costs one git process however many
 * agents ask about it at once. Without this, six sessions hitting one new path on the same tick each
 * pay for their own.
 */
const inflight = new Map<string, Promise<RepoInfo>>();

/**
 * Run git, distinguishing an answer from a failure to answer.
 *
 * git exits 128 for "this is not a repository", which is a fact about the directory and as good an
 * answer as a path. Everything else — a timeout while the object store is being repacked, a locked
 * index, git missing from PATH — says nothing about the directory at all, and treating the two alike
 * is how a worktree ends up filed as a repository of its own.
 */
async function git(dir: string, args: string[]): Promise<{ out: string } | { failed: boolean }> {
  // One at a time: on Windows starting a process holds the event loop for the whole CreateProcess,
  // and a burst of them back to back was a burst of the daemon not answering anything.
  const turn = gitQueue.then(() => undefined);
  let done!: () => void;
  gitQueue = new Promise<void>((r) => (done = r));
  await turn;
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return { out: stdout.trim() };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return { failed: code !== 128 };
  } finally {
    setImmediate(done);
  }
}

let gitQueue: Promise<void> = Promise.resolve();
/** How many git processes were started, for diag; read from the files instead wherever possible. */
export const gitStats = { spawned: 0, fromFiles: 0 };

const readText = (file: string): Promise<string | null> => fs.readFile(file, 'utf8').catch(() => null);

/*
 * Where a directory sits in git, read from the files git keeps rather than asked of git.
 *
 * Asking git was two processes per directory (and a third for the origin), for every directory a
 * session touched, again every minute. On Windows, starting a process holds the daemon's event loop
 * for as long as CreateProcess takes, which on a loaded desk is a few hundred milliseconds: with a
 * dozen busy sessions that added up to the daemon not answering for seconds at a time, and every web
 * terminal stuttering and dropping its connection. Reading `.git` is a handful of asynchronous file
 * reads that never hold the loop.
 *
 * The answer is git's own: the same toplevel (symlinks resolved), the same common directory for a
 * linked worktree or a submodule, the same branch as `symbolic-ref --short`. Anything this does not
 * recognise returns undefined, and git is asked after all.
 */
export async function repoFromFiles(dir: string): Promise<RepoInfo | null | undefined> {
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch {
    return null; // no such directory: git says the same (exit 128)
  }
  // Inside a .git folder, or a layout set by environment: git's own rules apply, so it is asked.
  if (real.split(/[\\/]/).includes('.git') || process.env.GIT_DIR || process.env.GIT_WORK_TREE) return undefined;
  for (let d = real; ; ) {
    const dotgit = path.join(d, '.git');
    const st = await fs.stat(dotgit).catch(() => null);
    if (st) {
      let gitDir: string;
      let common: string;
      if (st.isDirectory()) {
        gitDir = dotgit;
        common = dotgit;
      } else {
        const m = (await readText(dotgit))?.match(/^gitdir:\s*(.+?)\s*$/m);
        if (!m) return undefined;
        gitDir = path.resolve(d, m[1]);
        const commondir = (await readText(path.join(gitDir, 'commondir')))?.trim();
        common = commondir ? path.resolve(gitDir, commondir) : gitDir;
      }
      const head = await readText(path.join(gitDir, 'HEAD'));
      if (head === null) return undefined;
      common = await fs.realpath(common).catch(() => common);
      const root = path.basename(common) === '.git' ? path.dirname(common) : common;
      const ref = head.match(/^ref:\s*(\S+)/)?.[1] ?? null;
      const branch = ref ? ref.replace(/^refs\/(heads\/)?/, '') || null : null;
      return { root: path.resolve(root), worktree: path.resolve(d), branch, isGit: true };
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** remote.origin.url from a repository's config file; undefined when the file cannot be read. */
async function originFromFiles(root: string): Promise<string | null | undefined> {
  const dotgit = path.join(root, '.git');
  const st = await fs.stat(dotgit).catch(() => null);
  const configDir = st?.isDirectory() ? dotgit : st ? undefined : root; // a bare-style common dir is its own config's home
  if (!configDir) return undefined;
  const text = await readText(path.join(configDir, 'config'));
  if (text === null) return undefined;
  if (/^\s*\[include/im.test(text)) return undefined; // git follows includes; this does not
  let inOrigin = false;
  for (const line of text.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      inOrigin = /^remote\s+"origin"$/i.test(section[1].trim());
      continue;
    }
    const kv = inOrigin && line.match(/^\s*url\s*=\s*(.*?)\s*$/i);
    if (kv) return kv[1].replace(/^"(.*)"$/, '$1') || null;
  }
  return null;
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
    const alone: RepoInfo = { root: path.resolve(dir), worktree: path.resolve(dir), branch: null, isGit: false };
    const read = await repoFromFiles(dir).catch(() => undefined);
    if (read !== undefined) {
      gitStats.fromFiles++;
      const info = read ?? alone;
      cache.set(key, { info, at: Date.now() });
      return info;
    }
    gitStats.spawned++;
    const res = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']);
    if (!('out' in res)) {
      /*
       * git could not say. Answer for now with the directory standing alone, but remember nothing:
       * caching this would keep a worktree separated from its repository for a full minute after git
       * recovered, and an agent that registers inside that window is filed under a repository of its
       * own — on its own board, invisible to the agents it shares a tree with.
       */
      if (res.failed) return { ...alone, failed: true };
      cache.set(key, { info: alone, at: Date.now() });
      return alone;
    }
    const [common, top] = res.out.split(/\r?\n/);
    // An empty answer resolved as a path is the daemon's own folder, which is C:\Windows\System32
    // when Windows starts it: a repository of that name appeared on the board that way.
    if (!common || !path.isAbsolute(common)) return alone;
    const root = path.basename(common) === '.git' ? path.dirname(common) : common;
    const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const info: RepoInfo = {
      root: path.resolve(root),
      worktree: path.resolve(top ?? root),
      branch: 'out' in branch ? branch.out || null : null,
      isGit: true,
    };
    cache.set(key, { info, at: Date.now() });
    return info;
  })().finally(() => inflight.delete(key));

  inflight.set(key, pending);
  return pending;
}

const remotes = new Map<string, { url: string | null; at: number }>();

/**
 * The origin a repository was cloned from, or null for one without an origin. This is what a
 * repository is across desks: the same remote on two machines is the same repository, wherever each
 * keeps its clone. Cached like resolveRepo, and never thrown from.
 */
export async function originOf(dir: string): Promise<string | null> {
  const key = pathKey(dir);
  const hit = remotes.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS * 10) return hit.url;
  const read = await originFromFiles(dir).catch(() => undefined);
  if (read !== undefined) {
    remotes.set(key, { url: read, at: Date.now() });
    return read;
  }
  gitStats.spawned++;
  const res = await git(dir, ['config', '--get', 'remote.origin.url']);
  // `config --get` exits 1 for a key that is not set, which is an answer too: no origin.
  const url = 'out' in res ? res.out || null : null;
  remotes.set(key, { url, at: Date.now() });
  return url;
}

export function forgetRepoCache(dir: string): void {
  remotes.delete(pathKey(dir));
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
