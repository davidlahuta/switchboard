import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { CLI_PATH, DATA_DIR, HOME_CLAUDE_DIR, IS_WINDOWS, PACKAGE_ROOT, PROFILES_DIR, RUNTIME_DIR, VERSION, ensureDirs } from '../config.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeCommand, findClaude, projectSlug, readJson, writeJson } from '../daemon/claude.ts';
import { transcriptTitle } from '../daemon/transcript.ts';
import { CREDENTIALS_FILE, writeCredentials } from '../daemon/credsync.ts';
import { RepoScanner } from '../daemon/discovery.ts';
import { Launcher } from '../daemon/launcher.ts';
import { newestRunnerSourceMtime } from '../daemon/source.ts';
import { SHARED_DIRS } from '../daemon/subscriptions.ts';
import { sessionDir } from '../daemon/sessionDir.ts';
import { originOf, resolveRepo } from '../git.ts';
import { logger } from '../log.ts';
import {
  DESK_PATH_PREFIX,
  type DeskRepo,
  type DeskRun,
  type DeskRunInfo,
  type DeskSpawnExtras,
  type DeskToHub,
  type DeskTools,
  type HubToDesk,
  type MirrorRoot,
  type ProfileSeed,
  remoteKey,
} from '../shared/desk.ts';
import type { RunnerToDaemon, SpawnSpec } from '../shared/protocol.ts';
import { protect, unprotect } from '../daemon/secret.ts';
import { cloneRepo } from './clone.ts';
import { ensureShims, gitHelperEnv, pathWithShims } from './credential.ts';
import { toolStatus } from './tools.ts';

const log = logger('desk');
const execFileP = promisify(execFile);

export const DESK_CONFIG = path.join(DATA_DIR, 'desk.json');
export const DEFAULT_DESK_PORT = 4477;

/** How often mirrored files are looked at for growth. */
const MIRROR_TICK_MS = 1000;
/** Most a mirror sends in one tick, so a long transcript catches up without starving the socket. */
const MIRROR_BUDGET = 8 * 1024 * 1024;
const MIRROR_CHUNK = 1024 * 1024;
/** Files at most this big that are not transcripts are sent whole whenever they change. */
const SMALL_FILE = 256 * 1024;
const STATUS_EVERY_MS = 5000;
const LOGIN_TICK_MS = 2000;
const REPO_SCAN_EVERY_MS = 10 * 60_000;
const TOOLS_EVERY_MS = 10 * 60_000;
/** Hooks are given a little less than Claude Code gives them, so a slow hub answers "nothing" rather than timing out. */
const HOOK_TIMEOUT_MS = 4500;

export interface DeskConfig {
  hub: string;
  deskId: string;
  /** the desk token, DPAPI-protected where that is available */
  token: string;
  tokenProtected?: boolean;
  port: number;
  name?: string;
  repoRoots?: string[];
  cloneRoot?: string | null;
}

export function readDeskConfig(): DeskConfig | null {
  return readJson<DeskConfig>(DESK_CONFIG);
}

function saveDeskConfig(cfg: DeskConfig): void {
  ensureDirs();
  writeJson(DESK_CONFIG, cfg);
  // Where DPAPI is not there to seal the token (Linux), the file is the user's alone.
  if (!IS_WINDOWS) fs.chmodSync(DESK_CONFIG, 0o600);
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

function hubHttp(hub: string): string {
  return hub.trim().replace(/\/+$/, '');
}

/** Join a hub with the pairing code its Settings → Desks page shows. */
export async function joinDesk(hub: string, code: string, opts: { name?: string; port?: number }): Promise<DeskConfig> {
  const base = hubHttp(hub);
  const res = await fetch(`${base}/api/desks/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, hostname: os.hostname(), name: opts.name }),
  }).catch((err: unknown) => {
    throw new Error(`Cannot reach the hub at ${base}: ${err instanceof Error ? err.message : err}`);
  });
  const body = (await res.json().catch(() => ({}))) as { deskId?: string; token?: string; name?: string; error?: string };
  if (!res.ok || !body.deskId || !body.token) throw new Error(body.error ?? `The hub refused the code (HTTP ${res.status})`);
  const sealed = await protect(body.token);
  const cfg: DeskConfig = {
    hub: base,
    deskId: body.deskId,
    token: sealed ?? body.token,
    tokenProtected: sealed !== null,
    port: opts.port ?? DEFAULT_DESK_PORT,
    name: body.name,
  };
  saveDeskConfig(cfg);
  return cfg;
}

/** Where a session's Claude Code keeps its own login, on this desk. */
function loginDir(runId: string): string {
  return path.join(RUNTIME_DIR, 'creds', runId);
}

function comparable(p: string): string {
  const r = path.resolve(p);
  return IS_WINDOWS ? r.toLowerCase() : r;
}

/** `p` relative to `base` with forward slashes, or null when it is not inside it. */
function inside(base: string, p: string): string | null {
  const b = comparable(base);
  const f = comparable(p);
  if (!f.startsWith(b + path.sep)) return null;
  return path.resolve(p).slice(path.resolve(base).length + 1).split(path.sep).join('/');
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Follow {
  root: MirrorRoot;
  rel: string;
  abs: string;
  sent: number;
  mtime: number;
  size: number;
}

/**
 * The agent a satellite desk runs. It holds one connection to the hub, listens on 127.0.0.1 where a
 * daemon would, and does on this machine what the hub asks of it.
 */
export class DeskAgent {
  private readonly cfg: DeskConfig;
  private token = '';
  private readonly launcher = new Launcher();
  private readonly localUrl: string;
  private readonly hubWs: string;
  private control: WebSocket | null = null;
  private backoff = 1000;
  private runs = new Map<string, DeskRun>();
  private seed: ProfileSeed | null = null;
  /** hash of the login content the hub last gave each run, and of what was last sent back */
  private readonly loginWritten = new Map<string, string>();
  private readonly pids = new Map<string, number>();
  private readonly follows = new Map<string, Follow>();
  /** transcripts the hooks named, followed even before the run list says so */
  private readonly hookFiles = new Map<string, { root: MirrorRoot; rel: string; abs: string }>();
  private readonly transcripts = new Map<string, string>();
  private readonly scanner: RepoScanner;
  private tools: DeskTools | null = null;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(cfg: DeskConfig) {
    this.cfg = cfg;
    this.localUrl = `http://127.0.0.1:${cfg.port}`;
    this.hubWs = hubHttp(cfg.hub).replace(/^http/, 'ws');
    this.scanner = new RepoScanner(() => this.repoRoots());
  }

  private repoRoots(): string[] {
    if (this.cfg.repoRoots?.length) return this.cfg.repoRoots;
    const guess = [path.join(os.homedir(), 'source', 'repos'), path.join(os.homedir(), 'src'), path.join(os.homedir(), 'repos'), path.join(os.homedir(), 'code')];
    return guess.filter((d) => fs.existsSync(d));
  }

  private cloneRoot(): string {
    return this.cfg.cloneRoot || path.join(os.homedir(), 'source', 'repos');
  }

  async start(): Promise<void> {
    ensureDirs();
    this.token = this.cfg.tokenProtected ? ((await unprotect(this.cfg.token)) ?? '') : this.cfg.token;
    if (!this.token) throw new Error(`Could not read the desk token from ${DESK_CONFIG}. Join the hub again.`);
    await this.listen();
    this.connect();
    this.timers.push(setInterval(() => this.mirrorTick(), MIRROR_TICK_MS));
    this.timers.push(setInterval(() => this.sendStatus(), STATUS_EVERY_MS));
    this.timers.push(setInterval(() => this.loginTick(), LOGIN_TICK_MS));
    this.timers.push(setInterval(() => void this.scanRepos().catch(() => undefined), REPO_SCAN_EVERY_MS));
    this.timers.push(setInterval(() => void this.refreshTools(), TOOLS_EVERY_MS));
    log.info(`desk ${this.cfg.name ?? this.cfg.deskId} listening on ${this.localUrl}, hub ${this.cfg.hub}`);
  }

  // ------------------------------------------------------------ local side

  private listen(): Promise<void> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    const server = http.createServer((req, res) => void this.onHttp(req, res));
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!this.isLocal(req) || req.headers.origin || (url.pathname !== '/ws/runner' && url.pathname !== '/ws/agent')) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.bridge(ws, url.pathname));
    });
    return new Promise((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        reject(err.code === 'EADDRINUSE' ? new Error(`127.0.0.1:${this.cfg.port} is in use. Is a daemon or another desk agent running here?`) : err);
      });
      server.listen(this.cfg.port, '127.0.0.1', () => resolve());
    });
  }

  private isLocal(req: IncomingMessage): boolean {
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!this.isLocal(req) || req.headers.origin) return reply(403, { error: 'desk agent: local only' });
    if (url.pathname === '/healthz') return reply(200, { ok: true, desk: this.cfg.deskId, hub: this.online(), version: VERSION });
    // The vault, for git's helper and the gh/az shims of sessions on this desk: relayed as this desk.
    if (req.method === 'POST' && (url.pathname === '/api/cred/git' || url.pathname === '/api/cred/tool')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try {
        const res = await fetch(`${hubHttp(this.cfg.hub)}${url.pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
          body: Buffer.concat(chunks).toString('utf8'),
          signal: AbortSignal.timeout(20_000),
        });
        return reply(res.status, await res.json().catch(() => ({})));
      } catch {
        return reply(503, { error: 'the hub is not reachable' });
      }
    }
    const hook = url.pathname.match(/^\/hooks\/([A-Za-z]+)$/);
    if (req.method === 'POST' && hook) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return reply(200, await this.forwardHook(hook[1], Buffer.concat(chunks).toString('utf8'), req.headers['x-switchboard-run'] as string | undefined));
    }
    reply(404, { error: 'not found' });
  }

  /**
   * A Claude Code hook, carried to the hub. A transcript path is turned into the desk:// form the
   * hub maps onto its mirror, and the file is followed from now on. With the hub unreachable the
   * hook gets an empty answer, which is what Claude Code does with a daemon that is down: nothing
   * blocks, nothing is denied.
   */
  private async forwardHook(event: string, body: string, run: string | undefined): Promise<unknown> {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
    if (typeof p.transcript_path === 'string') {
      const mapped = this.toDeskPath(p.transcript_path);
      if (mapped) {
        this.hookFiles.set(mapped.root + '|' + mapped.rel, mapped);
        p.transcript_path = `${DESK_PATH_PREFIX}${mapped.root}/${mapped.rel}`;
      }
    }
    try {
      const res = await fetch(`${hubHttp(this.cfg.hub)}/hooks/${event}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, ...(run ? { 'x-switchboard-run': run } : {}) },
        body: JSON.stringify(p),
        signal: AbortSignal.timeout(event === 'SessionStart' ? HOOK_TIMEOUT_MS * 2 : HOOK_TIMEOUT_MS),
      });
      return res.ok ? await res.json() : {};
    } catch (err) {
      log.debug('a hook could not reach the hub; answered with nothing', { event, error: err instanceof Error ? err.message : err });
      return {};
    }
  }

  /** A file under this desk's ~/.claude or one of its profiles, as a mirror root and a relative path. */
  private toDeskPath(abs: string): { root: MirrorRoot; rel: string; abs: string } | null {
    const home = inside(HOME_CLAUDE_DIR, abs);
    if (home) return { root: 'home', rel: home, abs };
    const prof = inside(PROFILES_DIR, abs);
    if (!prof) return null;
    const [sub, ...rest] = prof.split('/');
    if (!sub || !rest.length) return null;
    // Profiles junction projects/ to ~/.claude/projects, so a transcript is the same file either way.
    if (rest[0] === 'projects') return { root: 'home', rel: rest.join('/'), abs };
    return { root: `profile/${sub}`, rel: rest.join('/'), abs };
  }

  /**
   * One local connection (a runner or an MCP shim) carried to the hub over a connection of its own,
   * authenticated as this desk. A runner's spawn is made into one for this machine on the way in.
   */
  private bridge(local: WebSocket, pathname: string): void {
    const runner = pathname === '/ws/runner';
    let runId: string | null = null;
    const upstream = new WebSocket(`${this.hubWs}${pathname}`, { headers: { authorization: `Bearer ${this.token}` }, maxPayload: 8 * 1024 * 1024 });
    const early: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    let inbound: Promise<void> = Promise.resolve();
    local.on('message', (data, binary) => {
      if (runner) {
        try {
          const msg = JSON.parse(String(data)) as RunnerToDaemon;
          if (msg.type === 'hello') {
            runId = msg.runId;
            if (runId && msg.pid) this.pids.set(runId, msg.pid);
          } else if (msg.type === 'spawned' && runId) this.pids.set(runId, msg.pid);
        } catch {
          // not ours to understand; passed on as it is
        }
      }
      if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary });
      else early.push({ data, binary });
    });
    upstream.on('open', () => {
      for (const m of early.splice(0)) upstream.send(m.data, { binary: m.binary });
    });
    upstream.on('message', (data, binary) => {
      // In order: a spawn being prepared must not be overtaken by the resize that follows it.
      inbound = inbound.then(async () => {
        let out: string | WebSocket.RawData = data;
        if (runner && !binary) {
          try {
            const msg = JSON.parse(String(data)) as { type: string; spec?: SpawnSpec & { desk?: DeskSpawnExtras } };
            if ((msg.type === 'spawn' || msg.type === 'swap') && msg.spec?.desk) {
              msg.spec = await this.materialize(msg.spec, runId);
              out = JSON.stringify(msg);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error('could not prepare a session on this desk', { run: runId, error: message });
            out = JSON.stringify({ type: 'error', message: `desk ${this.cfg.name ?? this.cfg.deskId}: ${message}` });
          }
        }
        if (local.readyState === local.OPEN) local.send(out, { binary: typeof out === 'string' ? false : binary });
      });
    });
    const closeBoth = (): void => {
      if (local.readyState === local.OPEN || local.readyState === local.CONNECTING) local.close();
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.close();
    };
    local.on('close', closeBoth);
    upstream.on('close', closeBoth);
    local.on('error', closeBoth);
    upstream.on('error', (err) => {
      log.debug('a relayed connection to the hub failed', { path: pathname, error: err.message });
      closeBoth();
    });
  }

  // ------------------------------------------------------------- spawning

  /**
   * The spec the hub built, made into one for this machine: this desk's claude, this desk's profile
   * for the subscription, its own copies of the files the arguments name, its own login directory.
   */
  private async materialize(spec: SpawnSpec & { desk?: DeskSpawnExtras }, runId: string | null): Promise<SpawnSpec> {
    const x = spec.desk!;
    if (!runId) throw new Error('a spawn for a runner that never said which session it is');
    const claude = findClaude();
    if (!claude) throw new Error('claude is not on PATH on this desk');
    const profile = await this.ensureProfile(x.subscriptionId);
    this.editClaudeJson(profile, (json) => {
      const key = path.resolve(x.trust).replace(/\\/g, '/');
      json.projects ??= {};
      json.projects[key] = { ...(json.projects[key] ?? {}), hasTrustDialogAccepted: true };
      json.diffSidebarOpen = x.diffPanel;
      json.mcpServers = { ...(json.mcpServers ?? {}), switchboard: this.mcpEntry() };
    });
    const dir = path.join(RUNTIME_DIR, 'spawn');
    fs.mkdirSync(dir, { recursive: true });
    const files = new Map<string, string>();
    for (const [hubPath, content] of Object.entries(x.files)) {
      const name = path.basename(hubPath.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]/g, '_');
      const local = path.join(dir, name);
      fs.writeFileSync(local, this.localise(content));
      files.set(hubPath, local);
    }
    const args = x.claudeArgs.map((a) => files.get(a) ?? a);
    // What is on this disk decides, not what the hub's copy of it says: resuming a conversation that
    // was never written fails, and starting one under an id that exists collides with it.
    const at = args.findIndex((a) => a === '--resume' || a === '--session-id');
    if (at >= 0 && args[at + 1]) {
      const has = this.findTranscript(args[at + 1]) !== null;
      if ((args[at] === '--resume') !== has) log.info('corrected how a session starts to what is on this desk', { run: runId, resume: has });
      args[at] = has ? '--resume' : '--session-id';
    }
    const cmd = claudeCommand(claude, args);
    const env: Record<string, string | null> = { ...spec.env, CLAUDE_CONFIG_DIR: profile, SWITCHBOARD_URL: this.localUrl };
    // The hub's vault, reached through this agent: git's helper, the gh/az shims, the Azure SDKs' environment.
    if (x.vault) {
      Object.assign(env, x.vault.env);
      if (x.vault.hosts.length) Object.assign(env, gitHelperEnv(x.vault.hosts));
      if (x.vault.shims) Object.assign(env, pathWithShims(ensureShims()));
    }
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = x.privateLogin ? await this.loginReady(runId) : null;
    const { desk: _drop, ...rest } = spec;
    return { ...rest, file: cmd.file, args: cmd.args, env };
  }

  /** The MCP server entry for this desk: its own Node and CLI, pointed at this agent. */
  private mcpEntry(env: Record<string, string> = {}): Record<string, unknown> {
    return { type: 'stdio', command: process.execPath, args: [CLI_PATH, 'mcp'], env: { ...env, SWITCHBOARD_URL: this.localUrl } };
  }

  /** A file the hub wrote for itself, made right for this desk: hooks and the MCP server pointed here. */
  private localise(content: string): string {
    const text = content.replace(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/hooks\//g, `${this.localUrl}/hooks/`);
    try {
      const json = JSON.parse(text) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
      const sb = json.mcpServers?.switchboard;
      if (sb) {
        json.mcpServers!.switchboard = this.mcpEntry(sb.env ?? {}) as { env?: Record<string, string> };
        return JSON.stringify(json, null, 2);
      }
    } catch {
      // not JSON: only the URLs needed changing
    }
    return text;
  }

  private editClaudeJson(profile: string, edit: (json: Record<string, any>) => void): void {
    const file = path.join(profile, '.claude.json');
    const json = readJson<Record<string, any>>(file) ?? {};
    const before = JSON.stringify(json);
    edit(json);
    if (JSON.stringify(json) !== before) writeJson(file, json);
  }

  /**
   * This desk's profile for a subscription. Its shared folders are junctions to this desk's own
   * ~/.claude, and its settings are the hub's, carried as contents. It never holds a login of its
   * own: a session reads a private copy the hub keeps current, so nothing on a satellite renews.
   */
  private async ensureProfile(subscriptionId: string): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(subscriptionId)) throw new Error(`bad subscription id ${subscriptionId}`);
    for (let i = 0; !this.seed && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
    const dir = path.join(PROFILES_DIR, subscriptionId);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SHARED_DIRS) {
      const target = path.join(HOME_CLAUDE_DIR, name);
      const link = path.join(dir, name);
      fs.mkdirSync(target, { recursive: true });
      try {
        fs.lstatSync(link);
        continue;
      } catch {
        // made below
      }
      try {
        fs.symlinkSync(target, link, IS_WINDOWS ? 'junction' : 'dir');
      } catch (err) {
        log.warn(`could not link ${name} into a profile`, err instanceof Error ? err.message : err);
        fs.mkdirSync(link, { recursive: true });
      }
    }
    for (const [name, content] of Object.entries(this.seed?.files ?? {})) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
      const file = path.join(dir, name);
      const want = this.localise(content);
      if (readText(file) !== want) fs.writeFileSync(file, want);
    }
    const claudeJson = path.join(dir, '.claude.json');
    if (!fs.existsSync(claudeJson)) writeJson(claudeJson, { ...(this.seed?.claudeJson ?? {}), hasCompletedOnboarding: true });
    // A stray login in a satellite profile would make a second renewer; see the hub's CredentialSync.
    fs.rmSync(path.join(dir, CREDENTIALS_FILE), { force: true });
    return dir;
  }

  /** The login directory for a session, once the hub has given it a login to put there. */
  private async loginReady(runId: string): Promise<string> {
    const dir = loginDir(runId);
    for (let i = 0; i < 80 && !fs.existsSync(path.join(dir, CREDENTIALS_FILE)); i++) await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(path.join(dir, CREDENTIALS_FILE))) log.warn('starting a session before its login arrived from the hub', { run: runId });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A conversation's transcript on this desk, if it has one. */
  private findTranscript(sessionId: string): string | null {
    const cached = this.transcripts.get(sessionId);
    if (cached && fs.existsSync(cached)) return cached;
    const projects = path.join(HOME_CLAUDE_DIR, 'projects');
    let names: string[] = [];
    try {
      names = fs.readdirSync(projects);
    } catch {
      return null;
    }
    for (const n of names) {
      const file = path.join(projects, n, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) {
        this.transcripts.set(sessionId, file);
        return file;
      }
    }
    return null;
  }

  // ------------------------------------------------------------- hub side

  private online(): boolean {
    return !!this.control && this.control.readyState === this.control.OPEN;
  }

  private connect(): void {
    const ws = new WebSocket(`${this.hubWs}/ws/desk`, { headers: { authorization: `Bearer ${this.token}` }, maxPayload: 16 * 1024 * 1024 });
    ws.on('open', () => {
      this.control = ws;
      this.backoff = 1000;
      log.info('connected to the hub', { hub: this.cfg.hub });
      void this.hello();
    });
    ws.on('message', (raw) => {
      let msg: HubToDesk;
      try {
        msg = JSON.parse(String(raw)) as HubToDesk;
      } catch {
        return;
      }
      void this.onMessage(msg).catch((err) => log.warn('a hub message failed', { type: msg.type, error: err instanceof Error ? err.message : err }));
    });
    ws.on('unexpected-response', (_req, res) => {
      log.error(`the hub refused this desk (HTTP ${res.statusCode}). If it was removed there, join again.`);
    });
    ws.on('close', (code) => {
      if (this.control === ws) this.control = null;
      if (code === 4401) log.error('the hub removed this desk; join again to come back');
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.on('error', (err) => log.debug('hub connection error', err.message));
  }

  private send(msg: DeskToHub): boolean {
    if (!this.control || this.control.readyState !== this.control.OPEN) return false;
    this.control.send(JSON.stringify(msg));
    return true;
  }

  private async refreshTools(): Promise<DeskTools> {
    this.tools = await toolStatus(!!this.launcher.wtPath);
    return this.tools;
  }

  private async hello(): Promise<void> {
    const tools = this.tools ?? (await this.refreshTools());
    this.send({
      type: 'hello',
      deskId: this.cfg.deskId,
      version: VERSION,
      hostname: os.hostname(),
      platform: process.platform,
      user: os.userInfo().username,
      cores: os.cpus().length,
      memGb: Math.round(os.totalmem() / 2 ** 30),
      tools,
      runnerSourceMtime: newestRunnerSourceMtime(),
      repoRoots: this.repoRoots(),
      cloneRoot: this.cloneRoot(),
    });
    // Everything mirrored is offered again from where the hub's copy is; it says resync if not.
    void this.scanRepos().catch(() => undefined);
  }

  private async onMessage(msg: HubToDesk): Promise<void> {
    switch (msg.type) {
      case 'welcome':
        log.info(`the hub knows this desk as ${msg.name}`);
        break;
      case 'seed':
        this.seed = msg.seed;
        break;
      case 'runs':
        this.runs = new Map(msg.runs.map((r) => [r.id, r]));
        for (const r of msg.runs) if (r.pid && !this.pids.has(r.id)) this.pids.set(r.id, r.pid);
        this.forgetEnded();
        break;
      case 'login':
        this.writeLogin(msg.runId, msg.content);
        break;
      case 'resync': {
        const f = this.follows.get(msg.root + '|' + msg.rel);
        if (f) f.sent = msg.from;
        break;
      }
      case 'rpc': {
        try {
          const value = await this.rpc(msg.method, msg.args);
          this.send({ type: 'rpc-result', id: msg.id, ok: true, value });
        } catch (err) {
          this.send({ type: 'rpc-result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      default:
        break;
    }
  }

  /** Sessions the hub no longer lists leave nothing behind: their login copy and their mirrors go. */
  private forgetEnded(): void {
    for (const [runId] of this.loginWritten) {
      if (this.runs.has(runId)) continue;
      this.loginWritten.delete(runId);
      fs.rmSync(loginDir(runId), { recursive: true, force: true });
    }
    for (const runId of [...this.pids.keys()]) if (!this.runs.has(runId)) this.pids.delete(runId);
  }

  /** What the hub may ask of this desk. Nothing here runs a command the hub names. */
  private async rpc(method: string, args: any): Promise<unknown> {
    switch (method) {
      case 'ping':
        return { ok: true, version: VERSION };
      case 'openTerminal': {
        const runId = String(args?.runId ?? '');
        if (!/^[a-f0-9]+$/.test(runId)) throw new Error('bad run id');
        const cwd = String(args?.cwd ?? '');
        const extra = this.cfg.port === DEFAULT_DESK_PORT ? [] : ['--daemon', this.localUrl];
        this.launcher.openTerminal({
          title: String(args?.title ?? runId),
          cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
          args: ['run', '--run-id', runId, ...extra],
          window: typeof args?.window === 'string' ? args.window : undefined,
          withoutWindowsTerminal: args?.withoutWindowsTerminal === true,
        });
        return { ok: true };
      }
      case 'stat': {
        try {
          const st = fs.statSync(String(args?.path ?? ''));
          return { isDir: st.isDirectory(), mtime: st.mtimeMs };
        } catch {
          return null;
        }
      }
      case 'resolveRepo': {
        const dir = String(args?.dir ?? '');
        const info = await resolveRepo(dir);
        const url = info.isGit ? await originOf(info.root) : null;
        return { ...info, remoteUrl: url, remoteKey: remoteKey(url) };
      }
      case 'scanRepos':
        return this.scanRepos(true);
      case 'clone': {
        // Credentials for the clone come from the vault through this agent, like a session's do.
        const hosts = Array.isArray(args?.vaultHosts) ? (args.vaultHosts as unknown[]).filter((h): h is string => typeof h === 'string') : [];
        const env = hosts.length ? { ...gitHelperEnv(hosts), SWITCHBOARD_URL: this.localUrl } : null;
        return this.clone(String(args?.url ?? ''), typeof args?.name === 'string' ? args.name : null, env);
      }
      case 'configure': {
        if (Array.isArray(args?.repoRoots)) this.cfg.repoRoots = args.repoRoots.filter((x: unknown): x is string => typeof x === 'string');
        if (args?.cloneRoot === null || typeof args?.cloneRoot === 'string') this.cfg.cloneRoot = args.cloneRoot || null;
        saveDeskConfig(this.cfg);
        void this.scanRepos(true).catch(() => undefined);
        return { repoRoots: this.repoRoots(), cloneRoot: this.cloneRoot() };
      }
      case 'tools':
        return this.refreshTools();
      case 'update':
        return this.selfUpdate();
      case 'updateClaude':
        return this.updateClaude();
      case 'recentSessions':
        return this.recentSessions(String(args?.cwd ?? ''));
      default:
        throw new Error(`unknown request ${method}`);
    }
  }

  /**
   * Bring this desk's Switchboard up to date with its own clone's remote, and restart the agent on
   * it: `git pull --ff-only`, `npm ci` when the lockfile moved, then exit for the supervisor (the
   * logon task, or systemd) to start it again. Sessions here keep running through it, as they do
   * through any agent restart, and reattach when it is back.
   */
  private async selfUpdate(): Promise<{ from: string; to: string; restarting: boolean }> {
    const git = async (...args: string[]): Promise<string> => (await execFileP('git', ['-C', PACKAGE_ROOT, ...args], { windowsHide: true, timeout: 120_000 })).stdout.trim();
    const from = await git('rev-parse', '--short', 'HEAD');
    const lockBefore = await git('rev-parse', 'HEAD:package-lock.json').catch(() => '');
    await git('pull', '--ff-only');
    const to = await git('rev-parse', '--short', 'HEAD');
    if (from === to) return { from, to, restarting: false };
    const lockAfter = await git('rev-parse', 'HEAD:package-lock.json').catch(() => '');
    if (lockBefore !== lockAfter) {
      await execFileP(IS_WINDOWS ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: PACKAGE_ROOT, windowsHide: true, timeout: 10 * 60_000, shell: IS_WINDOWS });
    }
    log.info('updated; restarting the agent', { from, to });
    setTimeout(() => process.exit(0), 500);
    return { from, to, restarting: true };
  }

  /** `claude update` on this desk, saying the version before and after. */
  private async updateClaude(): Promise<{ before: string | null; after: string | null; error?: string }> {
    const claude = findClaude();
    if (!claude) return { before: null, after: null, error: 'claude is not on PATH on this desk' };
    const version = async (): Promise<string | null> => {
      try {
        const cmd = claudeCommand(claude, ['--version']);
        const { stdout } = await execFileP(cmd.file, cmd.args, { windowsHide: true, timeout: 60_000, cwd: DATA_DIR });
        return stdout.trim().match(/\d+\.\d+\.\d+[^\s]*/)?.[0] ?? null;
      } catch {
        return null;
      }
    };
    const before = await version();
    let error: string | undefined;
    try {
      const cmd = claudeCommand(claude, ['update']);
      await execFileP(cmd.file, cmd.args, { windowsHide: true, timeout: 10 * 60_000, cwd: DATA_DIR });
    } catch (err) {
      error = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }
    const after = (await version()) ?? before;
    if (before !== after) void this.refreshTools();
    return { before, after, ...(error ? { error } : {}) };
  }

  private async scanRepos(refresh = false): Promise<DeskRepo[]> {
    const found = await this.scanner.list(refresh);
    const repos: DeskRepo[] = [];
    for (const r of found) {
      if (r.isWorktree) continue;
      const url = await originOf(r.path);
      repos.push({ path: r.path, remoteKey: remoteKey(url), remoteUrl: url, name: r.name, branch: r.branch });
    }
    this.send({ type: 'repos', repos });
    return repos;
  }

  private async clone(url: string, name: string | null, env: Record<string, string> | null): Promise<DeskRepo> {
    const repo = await cloneRepo(url, this.cloneRoot(), { name, env });
    void this.scanRepos(true).catch(() => undefined);
    return repo;
  }

  /** Conversations started in a folder on this desk, newest first, for resuming one. */
  private recentSessions(cwd: string): Array<{ id: string; title: string; mtime: string }> {
    const dir = path.join(HOME_CLAUDE_DIR, 'projects', projectSlug(cwd));
    let files: Array<{ file: string; mtime: number }> = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 20);
    } catch {
      return [];
    }
    return files.map(({ file, mtime }) => ({ id: file.slice(0, -6), title: transcriptTitle(path.join(dir, file)), mtime: new Date(mtime).toISOString() }));
  }

  // ------------------------------------------------------------- logins

  private writeLogin(runId: string, content: string | null): void {
    if (!/^[a-f0-9]+$/.test(runId)) return;
    const file = path.join(loginDir(runId), CREDENTIALS_FILE);
    if (content === null) {
      fs.rmSync(loginDir(runId), { recursive: true, force: true });
      this.loginWritten.delete(runId);
      return;
    }
    if (readText(file) !== content) writeCredentials(file, content);
    this.loginWritten.set(runId, sha256(content));
  }

  /** A session that renewed its own login: its file goes back to the hub, which decides whose it is. */
  private loginTick(): void {
    for (const [runId, hash] of this.loginWritten) {
      const content = readText(path.join(loginDir(runId), CREDENTIALS_FILE));
      if (content === null) continue;
      const now = sha256(content);
      if (now === hash) continue;
      if (this.send({ type: 'login-changed', runId, content })) this.loginWritten.set(runId, now);
    }
  }

  // ------------------------------------------------------------ mirrors

  /** The files of this desk's sessions that the hub reads: transcripts, titles, the process registry. */
  private wanted(): Map<string, { root: MirrorRoot; rel: string; abs: string }> {
    const out = new Map<string, { root: MirrorRoot; rel: string; abs: string }>();
    const add = (abs: string): void => {
      const m = this.toDeskPath(abs);
      if (m) out.set(m.root + '|' + m.rel, m);
    };
    for (const r of this.runs.values()) {
      if (!r.live) continue;
      const transcript = this.findTranscript(r.sessionId);
      if (transcript) {
        add(transcript);
        const own = path.join(path.dirname(transcript), r.sessionId);
        add(path.join(own, 'custom-title.json'));
        try {
          for (const n of fs.readdirSync(path.join(own, 'subagents'))) if (n.endsWith('.jsonl')) add(path.join(own, 'subagents', n));
        } catch {
          // no subagents yet
        }
      }
      const pid = this.pids.get(r.id) ?? r.pid;
      if (pid) for (const sub of new Set([r.subscriptionId, r.hostSub ?? r.subscriptionId])) add(path.join(PROFILES_DIR, sub, 'sessions', `${pid}.json`));
    }
    for (const [k, v] of this.hookFiles) out.set(k, v);
    return out;
  }

  private mirrorTick(): void {
    if (!this.online()) return;
    let budget = MIRROR_BUDGET;
    const wanted = this.wanted();
    for (const key of this.follows.keys()) if (!wanted.has(key)) this.follows.delete(key);
    for (const [key, w] of wanted) {
      if (budget <= 0) break;
      let st: fs.Stats;
      try {
        st = fs.statSync(w.abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let f = this.follows.get(key);
      if (!f) {
        f = { ...w, sent: 0, mtime: 0, size: 0 };
        this.follows.set(key, f);
      }
      const small = st.size <= SMALL_FILE && !w.rel.endsWith('.jsonl');
      if (small) {
        if (st.mtimeMs === f.mtime && st.size === f.size && f.sent === st.size) continue;
        const data = this.read(w.abs, 0, st.size);
        if (!data) continue;
        this.send({ type: 'file', root: w.root, rel: w.rel, offset: 0, data: data.toString('base64'), truncate: true });
        f.sent = data.length;
      } else {
        if (st.size < f.sent) f.sent = 0; // rewritten or truncated: start again
        while (f.sent < st.size && budget > 0) {
          const len = Math.min(MIRROR_CHUNK, st.size - f.sent, budget);
          const data = this.read(w.abs, f.sent, len);
          if (!data?.length) break;
          this.send({ type: 'file', root: w.root, rel: w.rel, offset: f.sent, data: data.toString('base64'), truncate: f.sent === 0 });
          f.sent += data.length;
          budget -= data.length;
        }
      }
      f.mtime = st.mtimeMs;
      f.size = st.size;
    }
  }

  private read(file: string, from: number, len: number): Buffer | null {
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, from);
        return buf.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- status

  private sendStatus(): void {
    const runs: Record<string, DeskRunInfo> = {};
    for (const r of this.runs.values()) {
      const home = sessionDir(r.cwd, r.lastCwd, fs.existsSync);
      runs[r.id] = { home, workDir: fs.existsSync(home), claudeAlive: pidAlive(this.pids.get(r.id) ?? r.pid) };
    }
    this.send({ type: 'status', runs, runnerSourceMtime: newestRunnerSourceMtime() });
  }
}

export async function runDeskAgent(): Promise<void> {
  const cfg = readDeskConfig();
  if (!cfg) {
    console.error(`This machine has not joined a hub yet (${DESK_CONFIG} is missing).\nOn the hub, open Settings → Desks → Add a desk, then run the command it shows here.`);
    process.exit(1);
  }
  delete process.env.SWITCHBOARD_RUN_ID;
  const agent = new DeskAgent(cfg);
  await agent.start();
}
