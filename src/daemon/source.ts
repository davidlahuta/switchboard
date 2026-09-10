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
