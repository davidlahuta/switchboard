import type { DiscoveredRepo, Repo } from '@shared/types.ts';
import { request } from './api.ts';

/**
 * A comparable key for a filesystem path. Separators are unified and case is folded, because the
 * daemon reports Windows paths where `C:\Src\App` and `c:/src/app` are the same directory — and a
 * repo appearing twice in the picker is exactly the confusion this list is meant to remove.
 */
export function pathKey(p: string): string {
  return p
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
}

/** GET /api/repos/discovered. `refresh` forces a rescan instead of the daemon's ~60s cache. */
export async function fetchDiscoveredRepos(refresh = false): Promise<DiscoveredRepo[]> {
  const res = await request<DiscoveredRepo[]>('GET', `/api/repos/discovered${refresh ? '?refresh=1' : ''}`);
  return Array.isArray(res) ? res : [];
}

/**
 * The discovered repos plus any repo Switchboard already knows about (one may sit outside every
 * configured root), deduped by path. Discovery wins on a tie: it knows the branch.
 */
export function mergeRepoChoices(discovered: DiscoveredRepo[], known: Repo[]): DiscoveredRepo[] {
  const byPath = new Map<string, DiscoveredRepo>();
  for (const d of discovered) byPath.set(pathKey(d.path), d);
  for (const r of known) {
    const key = pathKey(r.root);
    if (byPath.has(key)) continue;
    byPath.set(key, { path: r.root, name: r.name, branch: null, isWorktree: false, repoId: r.id, mainWorktree: r.root });
  }
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

export interface RepoGroup {
  repoId: string;
  /** The main worktree, or the first entry when only linked worktrees were found. */
  main: DiscoveredRepo;
  worktrees: DiscoveredRepo[];
}

/** Groups linked worktrees under the repository they belong to, so the list reads as one repo. */
export function groupRepos(repos: DiscoveredRepo[]): RepoGroup[] {
  const groups = new Map<string, DiscoveredRepo[]>();
  for (const r of repos) {
    const key = r.repoId || pathKey(r.mainWorktree || r.path);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: RepoGroup[] = [];
  for (const [repoId, list] of groups) {
    const mainIndex = list.findIndex((r) => !r.isWorktree);
    const main = list[mainIndex === -1 ? 0 : mainIndex];
    out.push({ repoId, main, worktrees: list.filter((r) => r !== main) });
  }
  return out.sort((a, b) => a.main.name.localeCompare(b.main.name) || a.main.path.localeCompare(b.main.path));
}

/** Case-insensitive substring match over the name and the path. An empty query matches everything. */
export function matchRepo(repo: DiscoveredRepo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return repo.name.toLowerCase().includes(q) || repo.path.toLowerCase().replace(/\\/g, '/').includes(q.replace(/\\/g, '/'));
}
