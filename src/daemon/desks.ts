import crypto from 'node:crypto';
import { execFileOff } from '../spawnOff.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import { DATA_DIR, PORT, VERSION } from '../config.ts';
import { logger } from '../log.ts';
import {
  defaultMaxSessions,
  type Desk,
  DESK_PATH_PREFIX,
  type DeskPairing,
  type DeskRepo,
  type DeskRun,
  type DeskRunInfo,
  type DeskToHub,
  type DeskTools,
  type HubToDesk,
  LOCAL_DESK,
  type MirrorRoot,
  type ProfileSeed,
} from '../shared/desk.ts';
import type { Bus } from './bus.ts';
import { writeCredentials } from './credsync.ts';
import { cloneRepo } from '../desk/clone.ts';
import { gitHelperEnv } from '../desk/credential.ts';
import { type Db, bool, now } from './db.ts';

const log = logger('desks');

const CODE_TTL_MS = 10 * 60_000;
const RPC_TIMEOUT_MS = 30_000;
/** How often each desk is told which sessions it has, besides whenever that changes. */
const RUNS_EVERY_MS = 10_000;
/** A desk that has said nothing for this long is offline, whatever its socket says. */
const SILENT_OFFLINE_MS = 45_000;
/**
 * How long a desk that has just come back is left to settle before its sessions are judged. A laptop
 * waking up reconnects its agent first and its sessions' terminals over the next few seconds; one
 * judged in between looks dead and would be opened a second time.
 */
const SETTLE_MS = 60_000;

interface DeskRow {
  id: string;
  name: string;
  hostname: string | null;
  token_hash: string | null;
  max_sessions: number | null;
  enabled: number;
  portable: number;
  clone_root: string | null;
  repo_roots: string | null;
  info_json: string | null;
  version: string | null;
  last_seen: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface DeskInfo {
  platform?: string;
  user?: string;
  cores?: number;
  memGb?: number;
  tools?: DeskTools;
  cloneRoot?: string;
  repoRoots?: string[];
}

interface Conn {
  /** when this connection was made, for settled() */
  since: number;
  ws: WebSocket;
  lastHeard: number;
  runnerSourceMtime: number;
  runs: Map<string, DeskRunInfo>;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  /** hash of the login content last sent for each run, so an unchanged one is not resent */
  loginsSent: Map<string, string>;
  /** the run list last sent, so an unchanged one is not resent */
  runsSent: string;
}

export interface DeskDeps {
  /** Live sessions per desk, for the load a desk is shown and placed by. */
  liveRuns: (deskId: string) => number;
  /** The sessions a satellite hosts, as it is told about them. */
  runsOn: (deskId: string) => DeskRun[];
  /** The hub's copy of a session's private login, when it has one. */
  loginFile: (runId: string) => string | null;
  /** What a desk profile is seeded with. */
  seed: () => ProfileSeed;
  /** Local desk facts the hub knows without asking anyone. */
  localTools: () => DeskTools | null;
  localRepoRoots: () => string[];
  /** The hub's own repositories, from its configured roots. */
  scanLocal: () => Promise<DeskRepo[]>;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

/** The hub's registry of desks, and its end of every satellite's connection. */
export class DeskManager {
  /** desks that went offline with sessions on them, so their return can be said */
  private readonly away = new Set<string>();
  private readonly db: Db;
  private readonly bus: Bus;
  private readonly deps: DeskDeps;
  private readonly conns = new Map<string, Conn>();
  private readonly codes = new Map<string, number>();
  private rpcSeq = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Desk repo reports, kept in memory too so placement does not query for every desk. */
  readonly mirrorRoot = path.join(DATA_DIR, 'desks');

  constructor(db: Db, bus: Bus, deps: DeskDeps) {
    this.db = db;
    this.bus = bus;
    this.deps = deps;
    this.ensureLocal();
  }

  start(): void {
    this.timer = setInterval(() => {
      for (const id of this.conns.keys()) this.pushRuns(id);
      this.expireSilent();
    }, RUNS_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.conns.values()) c.ws.close();
  }

  private ensureLocal(): void {
    if (this.row(LOCAL_DESK)) return;
    this.db.run('INSERT INTO desks (id, name, hostname, created_at) VALUES (?, ?, ?, ?)', LOCAL_DESK, os.hostname(), os.hostname(), now());
  }

  row(id: string): DeskRow | undefined {
    return this.db.get<DeskRow>('SELECT * FROM desks WHERE id = ? AND revoked_at IS NULL', id);
  }

  private rows(): DeskRow[] {
    return this.db.all<DeskRow>("SELECT * FROM desks WHERE revoked_at IS NULL ORDER BY (id <> 'local'), created_at");
  }

  /** Whether a desk can be asked to do something now. The hub's own desk always can. */
  online(id: string | null | undefined): boolean {
    if (!id || id === LOCAL_DESK) return true;
    const c = this.conns.get(id);
    return !!c && c.ws.readyState === c.ws.OPEN && Date.now() - c.lastHeard < SILENT_OFFLINE_MS;
  }

  /** Every satellite, connected or not. */
  satellites(): string[] {
    return this.rows()
      .filter((r) => r.id !== LOCAL_DESK)
      .map((r) => r.id);
  }

  private info(r: DeskRow): DeskInfo {
    try {
      return r.info_json ? (JSON.parse(r.info_json) as DeskInfo) : {};
    } catch {
      return {};
    }
  }

  /**
   * The path rules of a desk's own platform. A Windows hub must not resolve a Linux desk's
   * /home/... into C:\home\..., and the other way round; a desk that has not said yet is taken to
   * be like the hub.
   */
  pathOf(id: string | null | undefined): typeof path {
    if (!id || id === LOCAL_DESK) return path;
    const r = this.row(id);
    const platform = r ? this.info(r).platform : undefined;
    if (!platform) return path;
    return platform === 'win32' ? path.win32 : path.posix;
  }

  maxSessions(id: string): number {
    const r = this.row(id);
    if (!r) return 0;
    if (r.max_sessions !== null) return r.max_sessions;
    const info = r.id === LOCAL_DESK ? { cores: os.cpus().length, memGb: os.totalmem() / 2 ** 30 } : this.info(r);
    return defaultMaxSessions(info.cores ?? null, info.memGb ?? null);
  }

  enabled(id: string): boolean {
    const r = this.row(id);
    return !!r && bool(r.enabled);
  }

  portable(id: string): boolean {
    const r = this.row(id);
    return !!r && bool(r.portable);
  }

  /** Online and connected long enough for its sessions to have come back; see SETTLE_MS. */
  settled(id: string | null | undefined): boolean {
    if (!id || id === LOCAL_DESK) return true;
    const c = this.conns.get(id);
    return this.online(id) && !!c && Date.now() - c.since >= SETTLE_MS;
  }

  name(id: string | null | undefined): string {
    return this.row(id ?? LOCAL_DESK)?.name ?? id ?? LOCAL_DESK;
  }

  repos(id: string): DeskRepo[] {
    return this.db
      .all<{ path: string; remote_key: string | null; remote_url: string | null; name: string; branch: string | null }>(
        'SELECT path, remote_key, remote_url, name, branch FROM desk_repos WHERE desk_id = ? ORDER BY name',
        id,
      )
      .map((r) => ({ path: r.path, remoteKey: r.remote_key, remoteUrl: r.remote_url, name: r.name, branch: r.branch }));
  }

  /** Where a desk has a repository, if it has it. */
  repoPath(deskId: string, key: string): string | null {
    return this.db.get<{ path: string }>('SELECT path FROM desk_repos WHERE desk_id = ? AND remote_key = ? ORDER BY length(path) LIMIT 1', deskId, key)?.path ?? null;
  }

  /** Look through the hub's own repository roots again, and file what is there under its desk. */
  async scanLocal(): Promise<DeskRepo[]> {
    const repos = await this.deps.scanLocal();
    this.setRepos(LOCAL_DESK, repos);
    return repos;
  }

  /** Where a desk puts the repositories it clones. */
  cloneRoot(id: string): string {
    const r = this.row(id);
    if (r?.clone_root) return r.clone_root;
    if (id === LOCAL_DESK) return path.join(os.homedir(), 'source', 'repos');
    return (r ? this.info(r).cloneRoot : null) ?? path.join(os.homedir(), 'source', 'repos');
  }

  /** Clone a repository onto a desk: in this process for the hub's own, by asking for a satellite. */
  async clone(deskId: string, url: string, vaultHosts: string[] = []): Promise<DeskRepo> {
    if (deskId === LOCAL_DESK) {
      const env = vaultHosts.length ? gitHelperEnv(vaultHosts) : null;
      const repo = await cloneRepo(url, this.cloneRoot(LOCAL_DESK), { env });
      this.addRepo(LOCAL_DESK, repo);
      return repo;
    }
    return this.rpc<DeskRepo>(deskId, 'clone', { url, vaultHosts }, 30 * 60_000);
  }

  /** Replace what a desk is known to have cloned. */
  setRepos(deskId: string, repos: DeskRepo[]): void {
    const at = now();
    this.db.tx(() => {
      this.db.run('DELETE FROM desk_repos WHERE desk_id = ?', deskId);
      for (const r of repos) {
        this.db.run(
          'INSERT OR REPLACE INTO desk_repos (desk_id, path, remote_key, remote_url, name, branch, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          deskId,
          r.path,
          r.remoteKey,
          r.remoteUrl,
          r.name,
          r.branch,
          at,
        );
      }
    });
    this.bus.invalidate('state');
  }

  /** Note one repository a desk has just cloned, without waiting for its next scan. */
  addRepo(deskId: string, r: DeskRepo): void {
    this.db.run(
      'INSERT OR REPLACE INTO desk_repos (desk_id, path, remote_key, remote_url, name, branch, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      deskId,
      r.path,
      r.remoteKey,
      r.remoteUrl,
      r.name,
      r.branch,
      now(),
    );
    this.bus.invalidate('state');
  }

  list(): Desk[] {
    return this.rows().map((r) => this.dto(r));
  }

  get(id: string): Desk | null {
    const r = this.row(id);
    return r ? this.dto(r) : null;
  }

  private dto(r: DeskRow): Desk {
    const hub = r.id === LOCAL_DESK;
    const info = this.info(r);
    const cores = hub ? os.cpus().length : (info.cores ?? null);
    const memGb = hub ? Math.round(os.totalmem() / 2 ** 30) : (info.memGb ?? null);
    let roots: string[] = [];
    try {
      roots = r.repo_roots ? (JSON.parse(r.repo_roots) as string[]) : [];
    } catch {
      roots = [];
    }
    return {
      id: r.id,
      name: r.name,
      hub,
      hostname: hub ? os.hostname() : r.hostname,
      platform: hub ? process.platform : (info.platform ?? null),
      user: hub ? os.userInfo().username : (info.user ?? null),
      online: this.online(r.id),
      lastSeen: hub ? now() : r.last_seen,
      version: hub ? VERSION : r.version,
      recommendedMaxSessions: this.maxSessions(r.id),
      maxIsDefault: r.max_sessions === null,
      liveRuns: this.deps.liveRuns(r.id),
      enabled: bool(r.enabled),
      portable: bool(r.portable),
      settling: !hub && this.online(r.id) && !this.settled(r.id),
      cloneRoot: r.clone_root ?? info.cloneRoot ?? null,
      repoRoots: hub ? this.deps.localRepoRoots() : roots.length ? roots : (info.repoRoots ?? []),
      cores,
      memGb,
      tools: hub ? this.deps.localTools() : (info.tools ?? null),
      repos: this.repos(r.id),
      createdAt: r.created_at,
    };
  }

  update(id: string, patch: { name?: unknown; recommendedMaxSessions?: unknown; enabled?: unknown; portable?: unknown; cloneRoot?: unknown; repoRoots?: unknown }): Desk {
    const r = this.row(id);
    if (!r) throw httpError(404, 'Unknown desk');
    if (typeof patch.name === 'string' && patch.name.trim()) this.db.run('UPDATE desks SET name = ? WHERE id = ?', patch.name.trim().slice(0, 60), id);
    if (patch.recommendedMaxSessions === null) this.db.run('UPDATE desks SET max_sessions = NULL WHERE id = ?', id);
    else if (typeof patch.recommendedMaxSessions === 'number' && Number.isFinite(patch.recommendedMaxSessions)) {
      this.db.run('UPDATE desks SET max_sessions = ? WHERE id = ?', Math.max(0, Math.min(200, Math.round(patch.recommendedMaxSessions))), id);
    }
    if (typeof patch.enabled === 'boolean') this.db.run('UPDATE desks SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, id);
    if (typeof patch.portable === 'boolean' && id !== LOCAL_DESK) this.db.run('UPDATE desks SET portable = ? WHERE id = ?', patch.portable ? 1 : 0, id);
    if (patch.cloneRoot === null || typeof patch.cloneRoot === 'string') {
      const v = typeof patch.cloneRoot === 'string' && patch.cloneRoot.trim() ? patch.cloneRoot.trim() : null;
      this.db.run('UPDATE desks SET clone_root = ? WHERE id = ?', v, id);
    }
    if (Array.isArray(patch.repoRoots) && id !== LOCAL_DESK) {
      const roots = patch.repoRoots.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
      this.db.run('UPDATE desks SET repo_roots = ? WHERE id = ?', JSON.stringify(roots), id);
      // The desk scans its own disk; it is told what to scan and asked to look again.
      void this.rpc(id, 'configure', { repoRoots: roots, cloneRoot: this.row(id)?.clone_root ?? null }).catch(() => undefined);
    } else if (patch.cloneRoot !== undefined && id !== LOCAL_DESK) {
      void this.rpc(id, 'configure', { cloneRoot: this.row(id)?.clone_root ?? null }).catch(() => undefined);
    }
    this.bus.invalidate('state');
    return this.get(id)!;
  }

  /** Forget a satellite: its token stops working at once and its connection is closed. */
  remove(id: string): void {
    if (id === LOCAL_DESK) throw httpError(400, 'The hub cannot be removed');
    const r = this.row(id);
    if (!r) throw httpError(404, 'Unknown desk');
    if (this.deps.liveRuns(id) > 0) throw httpError(409, `${r.name} still has sessions running. Stop them first.`);
    this.db.run('UPDATE desks SET revoked_at = ?, token_hash = NULL WHERE id = ?', now(), id);
    this.db.run('DELETE FROM desk_repos WHERE desk_id = ?', id);
    this.conns.get(id)?.ws.close(4401, 'desk removed');
    this.conns.delete(id);
    log.info('removed a desk', { desk: id, name: r.name });
    this.bus.invalidate('state');
  }

  // ------------------------------------------------------------ pairing

  /** The address other machines on the tailnet reach this hub at, once found; see detectHubUrl. */
  hubUrl: string | null = null;

  /**
   * Find the address a desk joining from another machine should use: the https name `tailscale
   * serve` publishes this daemon under, which is how the phone reaches it too. Asked of the
   * tailscale CLI once at startup; null when there is no tailscale or nothing is served.
   */
  async detectHubUrl(): Promise<string | null> {
    // Set where the hub is reached some other way than tailscale serve: Headscale behind a proxy, say.
    const fixed = process.env.SWITCHBOARD_HUB_URL?.trim().replace(/\/+$/, '');
    if (fixed) {
      this.hubUrl = fixed;
      return fixed;
    }
    const out = await new Promise<string | null>((resolve) =>
      execFileOff('tailscale', ['serve', 'status', '--json'], { timeout: 10_000, windowsHide: true }).then((r) => resolve(r.stdout), () => resolve(null)),
    );
    try {
      const web = (JSON.parse(out ?? '{}') as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }).Web ?? {};
      for (const [hostPort, site] of Object.entries(web)) {
        const proxies = Object.values(site.Handlers ?? {}).map((h) => h.Proxy ?? '');
        if (!proxies.some((p) => new RegExp(`:${PORT}/?$`).test(p))) continue;
        const [host, port] = hostPort.split(':');
        this.hubUrl = port && port !== '443' ? `https://${host}:${port}` : `https://${host}`;
        log.info('desks will join this hub at its tailscale address', { url: this.hubUrl });
        return this.hubUrl;
      }
    } catch {
      // no tailscale, or an answer in a shape this does not know
    }
    return null;
  }

  /** Which desks may hold each repository; a repository not listed may be on any. */
  policies(): Array<{ remoteKey: string; allowedDesks: string[] | null }> {
    return this.db.all<{ remote_key: string; allowed_desks: string | null }>('SELECT remote_key, allowed_desks FROM repo_policy ORDER BY remote_key').map((r) => {
      let allowed: string[] | null = null;
      try {
        const v = r.allowed_desks ? (JSON.parse(r.allowed_desks) as unknown) : null;
        allowed = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
      } catch {
        allowed = null;
      }
      return { remoteKey: r.remote_key, allowedDesks: allowed };
    });
  }

  /** Limit a repository to some desks, or (null) let it be on any. */
  setPolicy(key: string, allowed: string[] | null): void {
    if (!key) throw httpError(400, 'remoteKey is required');
    if (allowed === null) this.db.run('UPDATE repo_policy SET allowed_desks = NULL WHERE remote_key = ?', key);
    else {
      const ids = allowed.filter((id) => !!this.row(id));
      this.db.run(
        'INSERT INTO repo_policy (remote_key, allowed_desks) VALUES (?, ?) ON CONFLICT(remote_key) DO UPDATE SET allowed_desks = excluded.allowed_desks',
        key,
        JSON.stringify(ids),
      );
    }
    this.bus.invalidate('state');
  }

  /** A one-time code for a new desk, and the command that uses it there. */
  createPairing(hubUrl: string): DeskPairing {
    for (const [c, exp] of this.codes) if (exp < Date.now()) this.codes.delete(c);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = [...crypto.randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join('');
    const expires = Date.now() + CODE_TTL_MS;
    this.codes.set(code, expires);
    return { code, expiresAt: new Date(expires).toISOString(), command: `node src/cli.ts desk join ${hubUrl} ${code}` };
  }

  /** Exchange a pairing code for a desk id and the token the desk will present from now on. */
  join(code: string, info: { hostname?: unknown; name?: unknown }): { deskId: string; token: string; name: string } {
    const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const token = crypto.randomBytes(32).toString('base64url');
    const hostname = typeof info.hostname === 'string' ? info.hostname.slice(0, 120) : null;
    // A claim: the machine joins as a desk that already exists (the old hub; see handover.ts).
    const claim = this.db.get<{ desk_id: string }>('SELECT desk_id FROM desk_claims WHERE code_hash = ? AND expires_at > ?', sha256(normalized), now());
    if (claim && this.row(claim.desk_id)) {
      this.db.run('DELETE FROM desk_claims WHERE code_hash = ?', sha256(normalized));
      this.db.run('UPDATE desks SET token_hash = ?, hostname = COALESCE(?, hostname), revoked_at = NULL WHERE id = ?', sha256(token), hostname, claim.desk_id);
      const name = this.name(claim.desk_id);
      log.info('a desk claimed its place', { desk: claim.desk_id, name, hostname });
      this.bus.toast('info', `${name} joined as the desk it was.`);
      this.bus.invalidate('state');
      return { deskId: claim.desk_id, token, name };
    }
    const expires = this.codes.get(normalized);
    if (!expires || expires < Date.now()) throw httpError(403, 'Invalid or expired desk pairing code. Make a new one in Settings → Desks.');
    this.codes.delete(normalized);
    const deskId = crypto.randomBytes(4).toString('hex');
    const name = (typeof info.name === 'string' && info.name.trim() ? info.name.trim() : (hostname ?? `desk-${deskId}`)).slice(0, 60);
    this.db.run('INSERT INTO desks (id, name, hostname, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', deskId, name, hostname, sha256(token), now());
    log.info('a desk joined', { desk: deskId, name, hostname });
    this.bus.toast('info', `${name} joined as a desk.`);
    this.bus.invalidate('state');
    return { deskId, token, name };
  }

  /** The desk a bearer token belongs to, or null. */
  deskOfToken(header: string | undefined): string | null {
    const m = header?.match(/^Bearer\s+(\S+)$/i);
    if (!m) return null;
    const row = this.db.get<{ id: string }>('SELECT id FROM desks WHERE token_hash = ? AND revoked_at IS NULL', sha256(m[1]));
    return row?.id ?? null;
  }

  // --------------------------------------------------------- connection

  attach(deskId: string, ws: WebSocket): void {
    const previous = this.conns.get(deskId);
    if (previous && previous.ws !== ws) previous.ws.close(4409, 'replaced by a newer connection');
    const conn: Conn = { ws, since: Date.now(), lastHeard: Date.now(), runnerSourceMtime: 0, runs: new Map(), pending: new Map(), loginsSent: new Map(), runsSent: '' };
    this.conns.set(deskId, conn);
    ws.on('message', (raw) => {
      let msg: DeskToHub;
      try {
        msg = JSON.parse(String(raw)) as DeskToHub;
      } catch {
        return;
      }
      conn.lastHeard = Date.now();
      try {
        this.onMessage(deskId, conn, msg);
      } catch (err) {
        log.warn('a desk message failed', { desk: deskId, type: msg.type, error: err instanceof Error ? err.message : err });
      }
    });
    ws.on('close', () => {
      if (this.conns.get(deskId) !== conn) return;
      this.conns.delete(deskId);
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`${this.name(deskId)} disconnected`));
      }
      log.warn('a desk disconnected', { desk: deskId, name: this.name(deskId) });
      this.db.run('UPDATE desks SET last_seen = ? WHERE id = ?', now(), deskId);
      // Said once, when it had sessions: a laptop closed for a meeting is not an error, but it is worth knowing.
      const live = this.deps.liveRuns(deskId);
      if (live > 0 && !this.away.has(deskId)) {
        this.away.add(deskId);
        this.bus.toast('warn', `${this.name(deskId)} went offline. Its ${live} session(s) keep running there and reattach when it is back.`);
      }
      this.bus.invalidate('state');
    });
  }

  private onMessage(deskId: string, conn: Conn, msg: DeskToHub): void {
    switch (msg.type) {
      case 'hello': {
        const info: DeskInfo = {
          platform: msg.platform,
          user: msg.user,
          cores: msg.cores,
          memGb: msg.memGb,
          tools: msg.tools,
          cloneRoot: msg.cloneRoot,
          repoRoots: msg.repoRoots,
        };
        this.db.run('UPDATE desks SET hostname = ?, info_json = ?, version = ?, last_seen = ? WHERE id = ?', msg.hostname, JSON.stringify(info), msg.version, now(), deskId);
        conn.runnerSourceMtime = msg.runnerSourceMtime;
        this.send(deskId, { type: 'welcome', deskId, name: this.name(deskId) });
        this.send(deskId, { type: 'seed', seed: this.deps.seed() });
        conn.runsSent = '';
        conn.loginsSent.clear();
        this.pushRuns(deskId);
        const r = this.row(deskId);
        if (r?.repo_roots || r?.clone_root) void this.rpc(deskId, 'configure', { repoRoots: r.repo_roots ? JSON.parse(r.repo_roots) : undefined, cloneRoot: r.clone_root }).catch(() => undefined);
        log.info('a desk connected', { desk: deskId, name: this.name(deskId), version: msg.version, host: msg.hostname, user: msg.user });
        if (this.away.delete(deskId)) this.bus.toast('info', `${this.name(deskId)} is back; its sessions are reattaching.`);
        this.bus.invalidate('state');
        break;
      }
      case 'rpc-result': {
        const p = conn.pending.get(msg.id);
        if (!p) break;
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(httpError(502, msg.error ?? 'the desk could not do it'));
        break;
      }
      case 'file':
        this.writeMirror(deskId, conn, msg);
        break;
      case 'login-changed':
        this.loginFromDesk(deskId, conn, msg.runId, msg.content);
        break;
      case 'status': {
        conn.runnerSourceMtime = msg.runnerSourceMtime;
        conn.runs = new Map(Object.entries(msg.runs));
        this.db.run('UPDATE desks SET last_seen = ? WHERE id = ?', now(), deskId);
        if (msg.tools) {
          const r = this.row(deskId);
          if (r) this.db.run('UPDATE desks SET info_json = ? WHERE id = ?', JSON.stringify({ ...this.info(r), tools: msg.tools }), deskId);
        }
        break;
      }
      case 'repos':
        this.setRepos(deskId, msg.repos);
        break;
      default:
        break;
    }
  }

  private send(deskId: string, msg: HubToDesk): boolean {
    const c = this.conns.get(deskId);
    if (!c || c.ws.readyState !== c.ws.OPEN) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Ask a desk to do something, and wait for its answer. */
  rpc<T = unknown>(deskId: string, method: string, args: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    const c = this.conns.get(deskId);
    if (!c || c.ws.readyState !== c.ws.OPEN) return Promise.reject(httpError(503, `${this.name(deskId)} is offline`));
    const id = ++this.rpcSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(httpError(504, `${this.name(deskId)} did not answer (${method})`));
      }, timeoutMs);
      c.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      c.ws.send(JSON.stringify({ type: 'rpc', id, method, args } satisfies HubToDesk));
    });
  }

  private expireSilent(): void {
    for (const [id, c] of this.conns) {
      if (Date.now() - c.lastHeard > SILENT_OFFLINE_MS * 2) {
        log.warn('a desk went silent; closing its connection', { desk: id });
        c.ws.terminate();
      }
    }
  }

  /** Tell a desk which sessions it hosts, if that has changed since it was last told. */
  pushRuns(deskId: string): void {
    const c = this.conns.get(deskId);
    if (!c) return;
    const runs = this.deps.runsOn(deskId);
    const text = JSON.stringify(runs);
    if (text === c.runsSent) return;
    if (this.send(deskId, { type: 'runs', runs })) c.runsSent = text;
  }

  // ------------------------------------------------------------- facts

  /** What a desk last said about one of its sessions. */
  runInfo(deskId: string, runId: string): DeskRunInfo | null {
    return this.conns.get(deskId)?.runs.get(runId) ?? null;
  }

  runnerSourceMtime(deskId: string): number {
    return this.conns.get(deskId)?.runnerSourceMtime ?? 0;
  }

  // ------------------------------------------------------------ mirrors

  /** Where the hub keeps its copy of a desk's files. */
  mirrorBase(deskId: string): string {
    return path.join(this.mirrorRoot, deskId);
  }

  /** The hub's copy of a file on a desk, or null for a path that would leave the mirror. */
  mirrorPath(deskId: string, root: MirrorRoot, rel: string): string | null {
    if (!/^[a-f0-9]+$/.test(deskId)) return null;
    if (root !== 'home' && !/^profile\/[A-Za-z0-9._-]+$/.test(root)) return null;
    const base = path.join(this.mirrorBase(deskId), ...root.split('/'));
    const file = path.resolve(base, ...rel.split(/[\\/]+/).filter(Boolean));
    if (!file.startsWith(base + path.sep)) return null;
    return file;
  }

  /** The mirror of a desk's ~/.claude, which is where its transcripts are. */
  mirrorHome(deskId: string): string {
    return path.join(this.mirrorBase(deskId), 'home');
  }

  /** The mirror of one of a desk's subscription profiles. */
  mirrorProfile(deskId: string, subscriptionId: string): string {
    return path.join(this.mirrorBase(deskId), 'profile', subscriptionId);
  }

  /** Every desk's mirrored ~/.claude, for finding a transcript by session id. */
  mirrorHomes(): string[] {
    return this.satellites().map((id) => this.mirrorHome(id));
  }

  /** A path a satellite reported in desk:// form, as the hub's mirror of it. */
  fromDeskPath(deskId: string, p: string | null): string | null {
    if (!p || !p.startsWith(DESK_PATH_PREFIX)) return p;
    const rest = p.slice(DESK_PATH_PREFIX.length);
    const m = rest.match(/^(home|profile\/[^/]+)\/(.+)$/);
    if (!m) return null;
    return this.mirrorPath(deskId, m[1] as MirrorRoot, m[2]);
  }

  private writeMirror(deskId: string, conn: Conn, msg: Extract<DeskToHub, { type: 'file' }>): void {
    const file = this.mirrorPath(deskId, msg.root, msg.rel);
    if (!file) {
      log.warn('a desk sent a file outside its mirror; ignored', { desk: deskId, root: msg.root, rel: msg.rel });
      return;
    }
    const data = Buffer.from(msg.data, 'base64');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (msg.truncate || msg.offset === 0) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return;
    }
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (msg.offset !== size) {
      // A piece arrived for a place the copy has not reached (or has passed): start over from what is here.
      this.send(deskId, { type: 'resync', root: msg.root, rel: msg.rel, from: msg.offset > size ? size : 0 });
      return;
    }
    fs.appendFileSync(file, data);
  }

  // ------------------------------------------------------------- logins

  /**
   * Keep every satellite session's private login in step with the hub's copy of it.
   *
   * The hub's copy is the one CredentialSync manages, exactly as for a session beside it: renewed
   * centrally, distributed, renewals carried home. The desk holds a mirror of it the session reads,
   * written whenever the hub's copy changes; a session renewing on the desk sends its file back.
   */
  syncLogins(runs: Array<{ runId: string; deskId: string }>): void {
    for (const { runId, deskId } of runs) {
      const c = this.conns.get(deskId);
      if (!c) continue;
      const file = this.deps.loginFile(runId);
      let content: string | null = null;
      try {
        content = file ? fs.readFileSync(file, 'utf8') : null;
      } catch {
        content = null;
      }
      const hash = content === null ? 'none' : sha256(content);
      if (c.loginsSent.get(runId) === hash) continue;
      if (this.send(deskId, { type: 'login', runId, content })) c.loginsSent.set(runId, hash);
    }
  }

  private loginFromDesk(deskId: string, conn: Conn, runId: string, content: string): void {
    const owner = this.deps.runsOn(deskId).some((r) => r.id === runId);
    if (!owner) {
      log.warn('a desk sent a login for a session it does not host; ignored', { desk: deskId, run: runId });
      return;
    }
    const file = this.deps.loginFile(runId);
    if (!file) return;
    writeCredentials(file, content);
    // Already what the desk has: not sent back to it.
    conn.loginsSent.set(runId, sha256(content));
    log.info('a satellite session renewed its login; carried to the hub copy', { desk: deskId, run: runId });
  }
}
