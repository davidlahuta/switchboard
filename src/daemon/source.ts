import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT } from '../config.ts';

let cache: { at: number; value: number } | null = null;

/**
 * Newest mtime under src/, in milliseconds.
 *
 * Switchboard runs TypeScript straight from source, so a process started before an edit keeps
 * serving the old code until it is relaunched. That applies to the daemon and to every session's
 * runner, and neither notices on its own.
 */
export function newestSourceMtime(): number {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          // vanished mid-scan
        }
      }
    }
  };
  walk(path.join(PACKAGE_ROOT, 'src'));
  cache = { at: Date.now(), value: newest };
  return newest;
}

let runnerCache: { at: number; value: number } | null = null;

/**
 * The source files a session's terminal host runs: the runner and everything it imports, followed
 * through the imports from the entry point.
 *
 * Measured against all of src/, every change to the daemon or the web UI marked every terminal as
 * running old code — a fix to the mirror, which lives in the daemon, had nine freshly relaunched
 * sessions badged "old host" the moment it was deployed, and set to be replaced in a new terminal
 * the next time anything restarted them, for code that had not changed in any of them.
 */
export function runnerSourceFiles(entry = path.join(PACKAGE_ROOT, 'src', 'runner', 'runner.ts')): string[] {
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];
  const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm;
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    seen.add(file);
    for (const m of text.matchAll(IMPORT)) queue.push(path.resolve(path.dirname(file), m[1] ?? m[2]));
  }
  return [...seen];
}

/** Newest mtime among the files a terminal host runs; see runnerSourceFiles. */
export function newestRunnerSourceMtime(): number {
  if (runnerCache && Date.now() - runnerCache.at < 10_000) return runnerCache.value;
  let newest = 0;
  for (const file of runnerSourceFiles()) {
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs);
    } catch {
      // vanished mid-scan
    }
  }
  runnerCache = { at: Date.now(), value: newest };
  return newest;
}
