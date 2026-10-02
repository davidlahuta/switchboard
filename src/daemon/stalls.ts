import { monitorEventLoopDelay } from 'node:perf_hooks';
import { gitStats } from '../git.ts';
import { logger } from '../log.ts';

const log = logger('stalls');

/*
 * How long the daemon goes without answering anything.
 *
 * Everything a person feels goes through one event loop: the web terminal's keystrokes and output,
 * hooks that a session waits on before it carries on, the board. When that loop is held — a process
 * started on Windows, a query over a table that grew — every session stutters at once, and a web
 * terminal that waits long enough says its connection was lost. That was found by profiling, after
 * weeks of it getting slowly worse. This measures it all the time instead: a minute with a long
 * stall is logged with what the daemon had been doing, and `switchboard diag` shows the last hour.
 */

/** A stall a person notices: typing that does not echo. */
const NOTICEABLE_MS = 250;
const WINDOW_MS = 60_000;
const KEEP = 60;

export interface StallMinute {
  at: string;
  maxMs: number;
  p99Ms: number;
  /** git processes started that minute; reading .git is preferred and costs nothing here */
  gitSpawned: number;
}

const minutes: StallMinute[] = [];

export function startStallWatch(): () => void {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  let spawned = gitStats.spawned;
  const timer = setInterval(() => {
    const m: StallMinute = {
      at: new Date().toISOString(),
      maxMs: Math.round(h.max / 1e6),
      p99Ms: Math.round(h.percentile(99) / 1e6),
      gitSpawned: gitStats.spawned - spawned,
    };
    spawned = gitStats.spawned;
    h.reset();
    minutes.push(m);
    if (minutes.length > KEEP) minutes.shift();
    if (m.maxMs >= NOTICEABLE_MS) log.warn('the daemon stopped answering for a while', { ...m, fromFiles: gitStats.fromFiles });
  }, WINDOW_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    h.disable();
  };
}

/** The last hour, a minute at a time, for diag. */
export function stallReport(): { minutes: StallMinute[]; worstMs: number; noticeable: number } {
  return {
    minutes: [...minutes],
    worstMs: minutes.reduce((a, m) => Math.max(a, m.maxMs), 0),
    noticeable: minutes.filter((m) => m.maxMs >= NOTICEABLE_MS).length,
  };
}
