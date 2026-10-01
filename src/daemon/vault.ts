import crypto from 'node:crypto';
import { logger } from '../log.ts';
import type { Bus } from './bus.ts';
import { type Db, now } from './db.ts';
import { protect, unprotect } from './secret.ts';

const log = logger('vault');

/*
 * Credentials for what sessions reach besides Claude: GitHub and Azure.
 *
 * They are kept here, on the hub, sealed with DPAPI, and handed out per request — never written to a
 * satellite's disk. git asks through the `switchboard credential` helper, scoped to the hosts a
 * profile covers; `gh` and `az` are reached through small shims that ask for a fresh token or login
 * on every call, so a GitHub App's one-hour token never goes stale inside a session that runs for a
 * day. A session on a satellite asks its desk agent, which relays to the hub as that desk.
 *
 * A profile covers a scope: a host and a path pattern, `github.com/contoso/*`, `dev.azure.com/*`.
 * The most specific scope that matches a repository's remote is the one used.
 */

export type CredKind = 'github-app' | 'github-pat' | 'ado-pat' | 'azure-sp';

export interface CredProfile {
  id: string;
  kind: CredKind;
  label: string;
  scope: string;
  /** Non-secret settings: the App id, a tenant and client id, a user name. */
  config: Record<string, string>;
  /** Whether a secret is stored (it is never sent back). */
  hasSecret: boolean;
  /** Whether that secret is sealed with DPAPI, or plain where DPAPI is not available. */
  sealed: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  kind: CredKind;
  label: string;
  scope: string;
  config_json: string | null;
  secret: string | null;
  sealed: number;
  created_at: string;
  updated_at: string;
}

export interface VaultSnapshot {
  hosts: string[];
  shims: boolean;
  env: Record<string, string>;
}

export interface GitCredential {
  username: string;
  password: string;
  /** when it stops working, for git to cache it no longer than that */
  expiresAt?: string;
}

/** What a tool shim should run with: environment to add, and for az a service principal to sign in as. */
export interface ToolCredential {
  env: Record<string, string>;
  azureLogin?: { tenantId: string; clientId: string; secret: string; subscriptionId?: string; profileId: string };
}

const KINDS: CredKind[] = ['github-app', 'github-pat', 'ado-pat', 'azure-sp'];
const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

/** The literal part of a scope, before any wildcard: how specific it is. */
function scopeWeight(scope: string): number {
  return scope.split('*')[0].length;
}

/** Whether `target` (host/path, lower case, no .git) falls under a scope like `github.com/contoso/*`. */
export function scopeMatches(scope: string, target: string): boolean {
  const s = scope.trim().toLowerCase().replace(/\/+$/, '');
  const t = target.toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!s) return false;
  if (!s.includes('*')) return t === s || t.startsWith(`${s}/`);
  const re = new RegExp(`^${s.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}(/.*)?$`);
  return re.test(t);
}

/** The most specific of several profiles for a target, or null. */
export function pickProfile<T extends { scope: string }>(profiles: T[], target: string): T | null {
  return profiles.filter((p) => scopeMatches(p.scope, target)).sort((a, b) => scopeWeight(b.scope) - scopeWeight(a.scope))[0] ?? null;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** A GitHub App's own JWT, signed with its private key, good for nine minutes. */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const sig = crypto.createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

const GITHUB_API = process.env.SWITCHBOARD_GITHUB_API ?? 'https://api.github.com';

export class Vault {
  private readonly db: Db;
  private readonly bus: Bus;
  /** Secrets once opened, so DPAPI is asked once per profile per daemon. */
  private readonly opened = new Map<string, string>();
  /** Installation per App and owner, and tokens per installation, until shortly before they expire. */
  private readonly installations = new Map<string, { id: number; at: number }>();
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(db: Db, bus: Bus) {
    this.db = db;
    this.bus = bus;
  }

  /**
   * What a session is started with, kept ready because a spawn is built synchronously: which hosts
   * git's helper goes in front of, whether gh and az go through shims, and the environment the Azure
   * SDKs read. Rebuilt whenever a profile changes.
   */
  snapshot: VaultSnapshot = { hosts: [], shims: false, env: {} };

  async refreshSnapshot(): Promise<VaultSnapshot> {
    const profiles = this.list();
    const hosts = [...new Set(profiles.filter((p) => p.kind !== 'azure-sp').map((p) => p.scope.split('/')[0]))].filter((h) => ['github.com', 'dev.azure.com'].includes(h));
    const shims = profiles.some((p) => p.kind === 'github-app' || p.kind === 'github-pat' || p.kind === 'azure-sp');
    let env: Record<string, string> = {};
    try {
      env = await this.sessionEnv();
    } catch (err) {
      log.warn('could not open a credential for sessions', err instanceof Error ? err.message : err);
    }
    this.snapshot = { hosts, shims, env };
    return this.snapshot;
  }

  private dto(r: Row): CredProfile {
    let config: Record<string, string> = {};
    try {
      config = r.config_json ? (JSON.parse(r.config_json) as Record<string, string>) : {};
    } catch {
      config = {};
    }
    return { id: r.id, kind: r.kind, label: r.label, scope: r.scope, config, hasSecret: !!r.secret, sealed: r.sealed === 1, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  list(): CredProfile[] {
    return this.db.all<Row>('SELECT * FROM cred_profiles ORDER BY kind, scope').map((r) => this.dto(r));
  }

  /** Whether any profile covers this host: git's helper is only put in front of hosts that have one. */
  hostsCovered(): string[] {
    return [...new Set(this.list().map((p) => p.scope.split('/')[0].toLowerCase()).filter(Boolean))];
  }

  private row(id: string): Row | undefined {
    return this.db.get<Row>('SELECT * FROM cred_profiles WHERE id = ?', id);
  }

  async save(input: { id?: string; kind?: unknown; label?: unknown; scope?: unknown; config?: unknown; secret?: unknown }): Promise<CredProfile> {
    const existing = input.id ? this.row(input.id) : undefined;
    if (input.id && !existing) throw httpError(404, 'Unknown credential profile');
    const kind = (existing?.kind ?? input.kind) as CredKind;
    if (!KINDS.includes(kind)) throw httpError(400, `kind must be one of ${KINDS.join(', ')}`);
    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 80) : (existing?.label ?? kind);
    const scope = typeof input.scope === 'string' && input.scope.trim() ? input.scope.trim().toLowerCase().replace(/^https?:\/\//, '') : (existing?.scope ?? '');
    if (!scope || !/^[a-z0-9.-]+(\/[^\s]*)?$/.test(scope)) throw httpError(400, 'scope is a host and an optional path pattern, e.g. github.com/contoso/* or dev.azure.com/*');
    const config: Record<string, string> = existing?.config_json ? (JSON.parse(existing.config_json) as Record<string, string>) : {};
    if (input.config && typeof input.config === 'object') {
      for (const [k, v] of Object.entries(input.config as Record<string, unknown>)) if (typeof v === 'string') config[k] = v.trim();
    }
    const need: Record<CredKind, string[]> = { 'github-app': ['appId'], 'github-pat': [], 'ado-pat': [], 'azure-sp': ['tenantId', 'clientId'] };
    for (const k of need[kind]) if (!config[k]) throw httpError(400, `${kind} needs ${k}`);
    let secret = existing?.secret ?? null;
    let sealed = existing?.sealed ?? 0;
    if (typeof input.secret === 'string' && input.secret.trim()) {
      const plain = input.secret.trim();
      if (kind === 'github-app' && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(plain)) throw httpError(400, 'A GitHub App secret is its private key (.pem contents).');
      const box = await protect(plain);
      secret = box ?? plain;
      sealed = box ? 1 : 0;
    }
    if (!secret) throw httpError(400, 'A secret is required: the private key, token or client secret.');
    const id = existing?.id ?? crypto.randomBytes(4).toString('hex');
    const ts = now();
    this.db.run(
      `INSERT INTO cred_profiles (id, kind, label, scope, config_json, secret, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, scope = excluded.scope, config_json = excluded.config_json, secret = excluded.secret, sealed = excluded.sealed, updated_at = excluded.updated_at`,
      id,
      kind,
      label,
      scope,
      JSON.stringify(config),
      secret,
      sealed,
      existing?.created_at ?? ts,
      ts,
    );
    this.opened.delete(id);
    for (const k of [...this.tokens.keys()]) if (k.startsWith(`${id}|`)) this.tokens.delete(k);
    log.info('saved a credential profile', { id, kind, scope, sealed: sealed === 1 });
    await this.refreshSnapshot();
    this.bus.invalidate('state');
    return this.dto(this.row(id)!);
  }

  async remove(id: string): Promise<void> {
    this.db.run('DELETE FROM cred_profiles WHERE id = ?', id);
    this.opened.delete(id);
    await this.refreshSnapshot();
    this.bus.invalidate('state');
  }

  private async secretOf(r: Row): Promise<string> {
    const hit = this.opened.get(r.id);
    if (hit) return hit;
    if (!r.secret) throw httpError(409, `${r.label} has no secret`);
    const plain = r.sealed ? await unprotect(r.secret) : r.secret;
    if (!plain) throw httpError(500, `${r.label}: its secret could not be opened (sealed by another Windows user or machine?)`);
    this.opened.set(r.id, plain);
    return plain;
  }

  private matching(target: string, kinds: CredKind[]): Row | null {
    const rows = this.db.all<Row>('SELECT * FROM cred_profiles').filter((r) => kinds.includes(r.kind));
    return pickProfile(rows, target);
  }

  // ------------------------------------------------------------- GitHub App

  private async githubFetch(pathname: string, init: RequestInit & { token: string }): Promise<Response> {
    return fetch(`${GITHUB_API}${pathname}`, {
      ...init,
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${init.token}`, 'user-agent': 'switchboard', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
  }

  /** The installation of an App that covers an owner (organisation or user). */
  private async installationFor(r: Row, owner: string): Promise<number> {
    const key = `${r.id}|${owner.toLowerCase()}`;
    const hit = this.installations.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.id;
    const jwt = appJwt(this.dto(r).config.appId, await this.secretOf(r));
    for (let page = 1; page <= 10; page++) {
      const res = await this.githubFetch(`/app/installations?per_page=100&page=${page}`, { token: jwt });
      if (!res.ok) throw httpError(502, `GitHub refused the App (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const list = (await res.json()) as Array<{ id: number; account?: { login?: string } }>;
      const found = list.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase());
      if (found) {
        this.installations.set(key, { id: found.id, at: Date.now() });
        return found.id;
      }
      if (list.length < 100) break;
    }
    throw httpError(404, `${r.label} is not installed on ${owner}. Install the App there (GitHub → Settings → Applications) and try again.`);
  }

  /** A token for an App's installation on an owner, minted when the last one is about to expire. */
  private async appToken(r: Row, owner: string): Promise<{ token: string; expiresAt: number }> {
    const installation = await this.installationFor(r, owner);
    const key = `${r.id}|${installation}`;
    const hit = this.tokens.get(key);
    if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit;
    const jwt = appJwt(this.dto(r).config.appId, await this.secretOf(r));
    const res = await this.githubFetch(`/app/installations/${installation}/access_tokens`, { token: jwt, method: 'POST' });
    if (!res.ok) throw httpError(502, `GitHub would not issue a token (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    const out = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    this.tokens.set(key, out);
    log.info('minted a GitHub App installation token', { profile: r.id, owner, expiresAt: body.expires_at });
    return out;
  }

  // ------------------------------------------------------------- handing out

  /** What git gets for a host and path, or null when no profile covers it. */
  async gitCredential(host: string, repoPath: string): Promise<GitCredential | null> {
    const h = host.toLowerCase();
    const p = repoPath.replace(/^\/+/, '').replace(/\.git$/, '');
    const r = this.matching(`${h}/${p}`, ['github-app', 'github-pat', 'ado-pat']);
    if (!r) return null;
    if (r.kind === 'github-app') {
      const owner = p.split('/')[0];
      if (!owner) return null;
      const t = await this.appToken(r, owner);
      return { username: 'x-access-token', password: t.token, expiresAt: new Date(t.expiresAt).toISOString() };
    }
    if (r.kind === 'github-pat') return { username: 'x-access-token', password: await this.secretOf(r) };
    return { username: this.dto(r).config.user || 'pat', password: await this.secretOf(r) };
  }

  /**
   * What a gh or az call gets. gh: a token for the repository it is run in (its origin, as the shim
   * reads it), or any GitHub profile when it is run outside one. az: a service principal to be signed
   * in as, and the Azure DevOps PAT the devops extension reads.
   */
  async toolCredential(tool: string, target: string | null): Promise<ToolCredential> {
    const out: ToolCredential = { env: {} };
    if (tool === 'gh') {
      const t = (target ?? '').toLowerCase();
      const host = t.split('/')[0] || 'github.com';
      const path = t.split('/').slice(1).join('/');
      if (host !== 'github.com') return out;
      let cred = path ? await this.gitCredential(host, path).catch(() => null) : null;
      if (!cred) {
        // Not in a repository it knows: the first GitHub profile, for gh api and the like.
        const any = this.db.all<Row>("SELECT * FROM cred_profiles WHERE kind IN ('github-pat', 'github-app') ORDER BY kind DESC")[0];
        if (any?.kind === 'github-pat') cred = { username: 'x-access-token', password: await this.secretOf(any) };
        else if (any?.kind === 'github-app') {
          const owner = this.dto(any).config.owner;
          if (owner) cred = { username: 'x-access-token', password: (await this.appToken(any, owner)).token };
        }
      }
      if (cred) out.env.GH_TOKEN = cred.password;
      return out;
    }
    if (tool === 'az') {
      const sp = target ? this.matching(target, ['azure-sp']) : null;
      const r = sp ?? this.db.all<Row>("SELECT * FROM cred_profiles WHERE kind = 'azure-sp' ORDER BY scope")[0];
      if (r) {
        const c = this.dto(r).config;
        out.azureLogin = { tenantId: c.tenantId, clientId: c.clientId, secret: await this.secretOf(r), subscriptionId: c.subscriptionId || undefined, profileId: r.id };
      }
      const ado = this.db.all<Row>("SELECT * FROM cred_profiles WHERE kind = 'ado-pat' ORDER BY scope")[0];
      if (ado) out.env.AZURE_DEVOPS_EXT_PAT = await this.secretOf(ado);
      return out;
    }
    return out;
  }

  /**
   * Environment a session is started with for what does not go through a shim: the Azure SDKs'
   * service principal (DefaultAzureCredential reads these) and the devops extension's PAT.
   */
  async sessionEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const sp = this.db.all<Row>("SELECT * FROM cred_profiles WHERE kind = 'azure-sp' ORDER BY scope")[0];
    if (sp) {
      const c = this.dto(sp).config;
      env.AZURE_TENANT_ID = c.tenantId;
      env.AZURE_CLIENT_ID = c.clientId;
      env.AZURE_CLIENT_SECRET = await this.secretOf(sp);
      if (c.subscriptionId) env.AZURE_SUBSCRIPTION_ID = c.subscriptionId;
    }
    const ado = this.db.all<Row>("SELECT * FROM cred_profiles WHERE kind = 'ado-pat' ORDER BY scope")[0];
    if (ado) env.AZURE_DEVOPS_EXT_PAT = await this.secretOf(ado);
    return env;
  }

  /** Check that a profile works, by asking the service it is for. Says what it found. */
  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    const r = this.row(id);
    if (!r) throw httpError(404, 'Unknown credential profile');
    try {
      if (r.kind === 'github-app') {
        const jwt = appJwt(this.dto(r).config.appId, await this.secretOf(r));
        const res = await this.githubFetch('/app/installations?per_page=100', { token: jwt });
        if (!res.ok) return { ok: false, detail: `GitHub refused it (${res.status})` };
        const list = (await res.json()) as Array<{ account?: { login?: string } }>;
        return { ok: true, detail: `installed on ${list.map((i) => i.account?.login).filter(Boolean).join(', ') || 'no accounts yet'}` };
      }
      if (r.kind === 'github-pat') {
        const res = await this.githubFetch('/user', { token: await this.secretOf(r) });
        if (!res.ok) return { ok: false, detail: `GitHub refused it (${res.status})` };
        return { ok: true, detail: `signed in as ${((await res.json()) as { login?: string }).login}` };
      }
      if (r.kind === 'ado-pat') {
        const org = r.scope.split('/')[1];
        if (!org || org === '*') return { ok: true, detail: 'stored (put the organisation in the scope to test it: dev.azure.com/<org>/*)' };
        const res = await fetch(`https://dev.azure.com/${org}/_apis/projects?api-version=7.1&$top=5`, {
          headers: { authorization: `Basic ${Buffer.from(`:${await this.secretOf(r)}`).toString('base64')}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { ok: false, detail: `Azure DevOps refused it (${res.status})` };
        const body = (await res.json()) as { count?: number };
        return { ok: true, detail: `sees ${body.count ?? 0} project(s) in ${org}` };
      }
      const c = this.dto(r).config;
      const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: await this.secretOf(r), scope: 'https://management.azure.com/.default' }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, detail: `Entra ID refused it (${res.status}): ${(await res.text()).slice(0, 160)}` };
      return { ok: true, detail: 'signed in as the service principal' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
