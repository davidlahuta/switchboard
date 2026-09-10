import fs from 'node:fs';
import path from 'node:path';
import { repoIdFor, resolveRepo } from '../git.ts';
import { logger } from '../log.ts';
import type { DiscoveredRepo } from '../shared/types.ts';

const log = logger('discovery');

const CACHE_MS = 60_000;
const MAX_DEPTH = 3;
const MAX_REPOS = 500;
/** Directories never worth descending into while looking for repositories. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.cache']);

/**
 * Finds the git repositories under the configured root folders, so starting a session is a pick
 * from a list rather than typing a path. A directory containing `.git` is a repository and is not
 * descended into, which keeps submodules and nested checkouts from exploding the scan.
 */
export class RepoScanner {
  private readonly roots: () => string[];
  private cache: DiscoveredRepo[] = [];
  private scannedAt = 0;
  private lastRoots = '';

  constructor(roots: () => string[]) {
    this.roots = roots;
  }

  async list(refresh = false): Promise<DiscoveredRepo[]> {
    const roots = this.roots();
    const key = roots.join('|');
    const stale = refresh || key !== this.lastRoots || Date.now() - this.scannedAt > CACHE_MS;
    if (!stale) return this.cache;
    this.cache = await this.scan(roots);
    this.scannedAt = Date.now();
    this.lastRoots = key;
    return this.cache;
  }

  private async scan(roots: string[]): Promise<DiscoveredRepo[]> {
    const dirs: string[] = [];
    const seen = new Set<string>();
    const started = Date.now();
    for (const root of roots) {
      let base: string;
      try {
        base = fs.realpathSync(path.resolve(root));
        if (!fs.statSync(base).isDirectory()) continue;
      } catch {
        log.warn('repo root is not readable', root);
        continue;
      }
      this.walk(base, 0, dirs, seen);
    }
    // Walking the tree is filesystem work and stays synchronous; asking git about each repo it found
    // is a subprocess apiece, so those go together rather than one after another.
    const found = await Promise.all(dirs.map((dir) => this.describe(dir)));
    found.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    log.debug(`scanned ${roots.length} root(s) in ${Date.now() - started}ms, found ${found.length} repos`);
    return found;
  }

  private walk(dir: string, depth: number, found: string[], seen: Set<string>): void {
    if (depth > MAX_DEPTH || found.length >= MAX_REPOS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, a junction we cannot follow)
    }
    // `.git` is a directory in a normal clone and a file in a linked worktree.
    if (entries.some((e) => e.name === '.git')) {
      const key = dir.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(dir);
      }
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      this.walk(path.join(dir, e.name), depth + 1, found, seen);
    }
  }

  private async describe(dir: string): Promise<DiscoveredRepo> {
    const info = await resolveRepo(dir);
    const isWorktree = path.resolve(info.worktree).toLowerCase() !== path.resolve(info.root).toLowerCase();
    return {
      path: dir,
      name: path.basename(dir),
      branch: info.branch,
      isWorktree,
      /** Group key: linked worktrees share the main worktree's id. */
      repoId: repoIdFor(info.root),
      mainWorktree: info.root,
    };
  }
}
