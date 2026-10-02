import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';

/*
 * Starting processes without holding the event loop.
 *
 * On Windows, child_process creates a process synchronously: the calling thread waits for
 * CreateProcess, and on a desk whose antivirus inspects every launch that is 50 ms to 2 s — measured
 * at up to a second for `git --version` and two for `claude --version`. The daemon's one event loop
 * carries every web terminal, every hook a session waits on and the board, so each process it
 * started was a moment in which every session stuttered, and enough of them close together dropped
 * the web terminals' connections. Every process the daemon starts goes through here instead, and is
 * created on a worker thread of its own; the event loop only ever sees the answer.
 */

export interface OffOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  shell?: boolean;
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  detached?: boolean;
  maxBuffer?: number;
  /** written to the process's stdin, which is then closed */
  input?: string;
  /** stdout delivered as it comes ('stdout' events) rather than collected */
  stream?: boolean;
  /** no pipes at all: for a process that outlives anybody's interest in it, like a terminal window */
  ignoreOutput?: boolean;
}

export type OffRequest = { op: 'run'; id: number; file: string; args: string[]; opts: OffOptions } | { op: 'kill'; id: number };

export type OffEvent =
  | { id: number; type: 'spawned'; pid: number | null }
  | { id: number; type: 'stdout'; data: string }
  | { id: number; type: 'error'; message: string; code?: string }
  | { id: number; type: 'exit'; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; killed: boolean };

/** A process started on the worker: 'spawned', 'stdout', 'error' and 'exit' (code, signal) events. */
export class OffChild extends EventEmitter {
  pid: number | null = null;
  readonly id: number;
  constructor(id: number) {
    super();
    this.id = id;
  }
  kill(): void {
    send({ op: 'kill', id: this.id });
  }
}

let worker: Worker | null = null;
let nextId = 1;
const live = new Map<number, OffChild>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./spawnWorker.ts', import.meta.url));
  w.unref();
  w.on('message', (e: OffEvent) => {
    const child = live.get(e.id);
    if (!child) return;
    if (e.type === 'spawned') {
      child.pid = e.pid;
      child.emit('spawned', e.pid);
    } else if (e.type === 'stdout') child.emit('stdout', e.data);
    else {
      live.delete(e.id);
      idle();
      if (e.type === 'error') child.emit('error', Object.assign(new Error(e.message), { code: e.code }));
      else child.emit('exit', e.code, e.signal, e);
    }
  });
  const lost = (why: string): void => {
    if (worker === w) worker = null;
    for (const [id, child] of live) {
      live.delete(id);
      child.emit('error', new Error(`the process starter stopped (${why})`));
    }
  };
  w.on('error', (err: Error) => lost(err.message));
  w.on('exit', (code) => lost(`exit ${code}`));
  worker = w;
  return w;
}

/** The worker keeps the process alive only while something it started is still running. */
function idle(): void {
  if (!live.size) worker?.unref();
}

function send(m: OffRequest): void {
  ensureWorker().postMessage(m);
}

/** Start a process on the worker thread. */
export function spawnOff(file: string, args: string[], opts: OffOptions = {}): OffChild {
  const child = new OffChild(nextId++);
  live.set(child.id, child);
  ensureWorker().ref();
  // An env object holds only strings, which is what a worker message can carry.
  send({ op: 'run', id: child.id, file, args, opts: { ...opts, env: opts.env ? { ...opts.env } : undefined } });
  return child;
}

/**
 * Like util.promisify(execFile): stdout and stderr, or a rejection whose `code` is the exit code
 * (or the errno, 'ENOENT' for a program that is not there) and which carries both outputs.
 */
export function execFileOff(file: string, args: string[], opts: OffOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnOff(file, args, opts);
    child.on('error', reject);
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null, e: Extract<OffEvent, { type: 'exit' }>) => {
      if (code === 0 && !e.killed) {
        resolve({ stdout: e.stdout, stderr: e.stderr });
        return;
      }
      const err = Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}${e.killed ? ' (timed out)' : ''}\n${e.stderr}`), {
        code: e.killed ? null : code,
        signal,
        killed: e.killed,
        stdout: e.stdout,
        stderr: e.stderr,
      });
      reject(err);
    });
  });
}
