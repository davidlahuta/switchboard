import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CLI_PATH, DATA_DIR, DAEMON_URL, IS_WINDOWS } from '../config.ts';
import { remoteKey } from '../shared/desk.ts';

const run = promisify(execFile);

/*
 * The session side of the hub's vault (see src/daemon/vault.ts): git's credential helper and the
 * shims gh and az are reached through. Each asks whoever SWITCHBOARD_URL names — the daemon beside
 * the session, or the desk agent on a satellite, which relays to the hub — and keeps nothing.
 */

/** Hosts whose credentials come from the vault when a profile covers them. */
export const VAULT_HOSTS = ['github.com', 'dev.azure.com'];

/** Tools reached through a shim, so each call gets a fresh token or login. */
export const SHIMMED = ['gh', 'az'];

function daemonUrl(): string {
  return (process.env.SWITCHBOARD_URL ?? DAEMON_URL).replace(/\/+$/, '');
}

/** The one place a node path goes into a shell line git runs: forward slashes, quoted. */
function shellPath(p: string): string {
  return `"${p.replace(/\\/g, '/')}"`;
}

/**
 * git configuration, as GIT_CONFIG_* environment, that puts the helper in front of the vault's
 * hosts and nothing else: each host's helper list is reset first, so git does not fall through to
 * a credential manager prompting nobody, and asks with the repository path, which picks the App
 * installation or profile.
 */
export function gitHelperEnv(hosts: string[], node = process.execPath, cli = CLI_PATH): Record<string, string> {
  const entries: Array<[string, string]> = [];
  for (const h of hosts) {
    entries.push([`credential.https://${h}.helper`, '']);
    entries.push([`credential.https://${h}.helper`, `!${shellPath(node)} ${shellPath(cli)} credential`]);
    entries.push([`credential.https://${h}.useHttpPath`, 'true']);
  }
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** The folder of shims for this install, made or brought up to date. */
export function ensureShims(dir = path.join(DATA_DIR, 'bin')): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of SHIMMED) {
    if (IS_WINDOWS) {
      const file = path.join(dir, `${tool}.cmd`);
      const text = `@echo off\r\n"${process.execPath}" "${CLI_PATH}" cred-exec ${tool} %*\r\n`;
      if (readText(file) !== text) fs.writeFileSync(file, text);
    } else {
      const file = path.join(dir, tool);
      const text = `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" cred-exec ${tool} "$@"\n`;
      if (readText(file) !== text) fs.writeFileSync(file, text, { mode: 0o755 });
    }
  }
  return dir;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** PATH with the shim folder in front, under the name this platform's environment uses for it. */
export function pathWithShims(shims: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? (IS_WINDOWS ? 'Path' : 'PATH');
  const rest = (env[key] ?? '').split(path.delimiter).filter((d) => d && path.resolve(d) !== path.resolve(shims));
  return { [key]: [shims, ...rest].join(path.delimiter) };
}

async function post<T>(pathname: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${daemonUrl()}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.SWITCHBOARD_RUN_ID ? { 'x-switchboard-run': process.env.SWITCHBOARD_RUN_ID } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** `git credential` protocol: key=value lines on stdin, answered on stdout. Only `get` answers. */
export async function gitCredentialHelper(op: string): Promise<void> {
  const input = await new Promise<string>((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (text += c));
    process.stdin.on('end', () => resolve(text));
  });
  if (op !== 'get') return;
  const req: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) req[line.slice(0, i)] = line.slice(i + 1);
  }
  if (req.protocol !== 'https' || !req.host) return;
  const cred = await post<{ username: string; password: string; expiresAt?: string }>('/api/cred/git', { host: req.host, path: req.path ?? '' });
  if (!cred) return;
  const lines = [`username=${cred.username}`, `password=${cred.password}`];
  if (cred.expiresAt) lines.push(`password_expiry_utc=${Math.floor(Date.parse(cred.expiresAt) / 1000)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** The real binary of a shimmed tool: the first one on PATH that is not the shim itself. */
function realBinary(tool: string): string | null {
  const shims = path.resolve(path.join(DATA_DIR, 'bin'));
  const exts = IS_WINDOWS ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!dir || path.resolve(dir) === shims) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${tool}${ext}`);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** The repository the current folder is a clone of, as host/path, if it is one. */
async function hereTarget(): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['config', '--get', 'remote.origin.url'], { timeout: 5000, windowsHide: true });
    return remoteKey(stdout.trim());
  } catch {
    return null;
  }
}

/** A child that runs a .cmd needs the shell on Windows; its arguments are quoted for it here. */
function start(file: string, args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawn> {
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(file)) {
    const q = (s: string): string => (/^[A-Za-z0-9_\-.:/\\=]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
    return spawn(`"${file}" ${args.map(q).join(' ')}`, { stdio: 'inherit', env, shell: true, windowsHide: false });
  }
  return spawn(file, args, { stdio: 'inherit', env });
}

function wait(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(127));
  });
}

/**
 * Run gh or az with what the vault has for it. gh gets a fresh token for the repository it is run
 * in; az is signed in as the vault's service principal, in a config folder of its own, the first
 * time and whenever that sign-in has lapsed. With nothing in the vault, the tool runs as it is.
 */
export async function credExec(tool: string, args: string[]): Promise<never> {
  const real = realBinary(tool);
  if (!real) {
    process.stderr.write(`switchboard: ${tool} is not installed on this machine\n`);
    process.exit(127);
  }
  const target = await hereTarget();
  const cred = await post<{ env: Record<string, string>; azureLogin?: { tenantId: string; clientId: string; secret: string; subscriptionId?: string; profileId: string } }>(
    '/api/cred/tool',
    { tool, target },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...(cred?.env ?? {}) };
  if (tool === 'az' && cred?.azureLogin) {
    const a = cred.azureLogin;
    env.AZURE_CONFIG_DIR = path.join(DATA_DIR, 'az', a.profileId);
    fs.mkdirSync(env.AZURE_CONFIG_DIR, { recursive: true });
    const quiet = (extra: string[]): Promise<number> =>
      new Promise((resolve) => {
        const c = IS_WINDOWS && /\.(cmd|bat)$/i.test(real)
          ? spawn(`"${real}" ${extra.map((s) => `"${s}"`).join(' ')}`, { stdio: 'ignore', env, shell: true, windowsHide: true })
          : spawn(real, extra, { stdio: 'ignore', env });
        c.on('exit', (code) => resolve(code ?? 1));
        c.on('error', () => resolve(1));
      });
    if ((await quiet(['account', 'show', '-o', 'none'])) !== 0) {
      await quiet(['login', '--service-principal', '-u', a.clientId, '-p', a.secret, '--tenant', a.tenantId, '-o', 'none']);
      if (a.subscriptionId) await quiet(['account', 'set', '--subscription', a.subscriptionId]);
    }
  }
  process.exit(await wait(start(real, args, env)));
}
