import { spawn, type ChildProcess } from 'node:child_process';
import { parentPort } from 'node:worker_threads';
import type { OffRequest, OffEvent } from './spawnOff.ts';

/*
 * The thread that starts processes for the daemon; see spawnOff.ts. Creating a process on Windows
 * holds the thread that asks for as long as CreateProcess takes, which on a desk with an antivirus
 * scanning every launch is up to two seconds. Here that holds nobody.
 */

const port = parentPort!;
const children = new Map<number, ChildProcess>();
const post = (e: OffEvent): void => port.postMessage(e);

port.on('message', (m: OffRequest) => {
  if (m.op === 'kill') {
    children.get(m.id)?.kill();
    return;
  }
  if (m.op === 'write') {
    children.get(m.id)?.stdin?.write(m.data);
    return;
  }
  const o = m.opts;
  let child: ChildProcess;
  try {
    child = spawn(m.file, m.args, {
      cwd: o.cwd,
      env: o.env,
      shell: o.shell,
      windowsHide: o.windowsHide ?? true,
      windowsVerbatimArguments: o.windowsVerbatimArguments,
      detached: o.detached,
      stdio: [o.input !== undefined || o.stdin ? 'pipe' : 'ignore', o.ignoreOutput ? 'ignore' : 'pipe', o.ignoreOutput ? 'ignore' : 'pipe'],
    });
  } catch (err) {
    post({ id: m.id, type: 'error', message: err instanceof Error ? err.message : String(err), code: (err as NodeJS.ErrnoException).code });
    return;
  }
  children.set(m.id, child);
  let stdout = '';
  let stderr = '';
  let killed = false;
  const max = o.maxBuffer ?? 16 * 1024 * 1024;
  const timer = o.timeout
    ? setTimeout(() => {
        killed = true;
        child.kill();
      }, o.timeout)
    : null;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d: string) => {
    if (o.stream) post({ id: m.id, type: 'stdout', data: d });
    else if (stdout.length < max) stdout += d;
  });
  child.stderr?.on('data', (d: string) => {
    if (o.stream) post({ id: m.id, type: 'stderr', data: d });
    if (stderr.length < max) stderr += d;
  });
  child.stdin?.on('error', () => undefined); // a process that exits before reading what it was sent
  child.on('spawn', () => post({ id: m.id, type: 'spawned', pid: child.pid ?? null }));
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (timer) clearTimeout(timer);
    children.delete(m.id);
    post({ id: m.id, type: 'error', message: err.message, code: err.code });
  });
  child.on('close', (code, signal) => {
    if (timer) clearTimeout(timer);
    children.delete(m.id);
    post({ id: m.id, type: 'exit', code, signal, stdout, stderr, killed });
  });
  if (o.input !== undefined) child.stdin?.end(o.input);
  if (o.detached) child.unref();
});
