import path from 'node:path';

/**
 * The folder a session is opened in when it comes back: where it last was, while that is still part
 * of the folder it was started in, and otherwise the folder it was started in.
 *
 * `last_cwd` follows the session's shell wherever it goes, and sessions go to odd places. tailspin
 * and agent loop rename had wandered into their own temp scratchpads, and the next terminal opened
 * there: Claude Code took that folder's settings instead of the repository's, and a scratchpad
 * cleaned up by Windows would have left the session impossible to open anywhere. A worktree inside
 * the repository is where a session genuinely works, so that is kept.
 */
export function sessionDir(cwd: string, lastCwd: string | null, exists: (dir: string) => boolean): string {
  if (!lastCwd || !exists(lastCwd)) return cwd;
  const norm = (p: string): string => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const root = norm(cwd);
  const last = norm(lastCwd);
  if (last !== root && !last.startsWith(root + path.sep)) return cwd;
  /*
   * The working tree it was in, not whichever folder of it the shell happened to be in. A worktree
   * under .claude/worktrees has a .git of its own and is kept; 0376 literal reader's shell was in
   * the repository's .docs/specs, and its 17:40 terminal opened there and trusted that folder as if
   * it were a project.
   */
  for (let dir = path.resolve(lastCwd); ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, '.git'))) return dir;
    if (norm(dir) === root || path.dirname(dir) === dir) return cwd;
  }
}
