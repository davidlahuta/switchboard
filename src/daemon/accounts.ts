import crypto from 'node:crypto';
import { PORT } from '../config.ts';
import { logger } from '../log.ts';
import {
  type Account,
  type AccountApp,
  type AccountKind,
  type AccountsSnapshot,
  type AccountStatus,
  GOOGLE_SCOPES,
  MS_CONSUMER_TENANT,
  type Provider,
  PROVIDERS,
  type RunAccount,
  accountIdFrom,
  accountServer,
  msAuthority,
  msScopes,
  oauthCallbackPath,
  validAccountId,
} from '../shared/accounts.ts';
import type { Bus } from './bus.ts';
import { type Db, now } from './db.ts';
import { protect, unprotect } from './secret.ts';

const log = logger('accounts');

/*
 * Google and Microsoft accounts that sessions can use (Gmail, Drive, Calendar, Outlook, Teams,
 * OneDrive...), held here the way subscriptions are.
 *
 * Each provider is reached through the operator's own OAuth app, registered once and never sent for
 * review: a Google "Web application" client in a project published to production, and a Microsoft
 * public client (no secret) in a tenant of the operator's. Until an app is configured its provider is
 * simply not offered, and nothing else in Switchboard changes.
 *
 * What is kept: each account's refresh token, sealed like every other secret here, and the Google
 * client secret. Neither ever leaves the hub. A session gets short-lived access tokens, and only for
 * the accounts it was started with: its MCP servers ask for them with a ticket that is made for each
 * spawn of that run (see RunManager.buildSpec), through /api/cred/account, relayed by the desk agent
 * on a satellite. Every token handed out is recorded (account_mints).
 */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const MS_LOGIN = 'https://login.microsoftonline.com';

/** How long a sign-in may take between leaving for the provider and coming back. */
const FLOW_TTL_MS = 10 * 60_000;
/** An access token is handed out again until this close to its expiry. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const MINT_RETENTION_DAYS = 30;

type Fetch = typeof fetch;

interface AppRow {
  provider: Provider;
  client_id: string;
  tenant: string | null;
  secret: string | null;
  sealed: number;
  updated_at: string;
}

interface AccountRow {
  id: string;
  provider: Provider;
  kind: AccountKind;
  email: string;
  display_name: string | null;
  subject: string;
  tenant: string | null;
  scopes: string;
  refresh_token: string | null;
  sealed: number;
  status: AccountStatus;
  last_error: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Flow {
  provider: Provider;
  kind: AccountKind;
  verifier: string;
  redirectUri: string;
  /** set when the flow reconnects an existing account */
  accountId: string | null;
  expires: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface MintResult {
  accessToken: string;
  /** epoch ms */
  expiresAt: number;
}

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer): string => b.toString('base64url');

/** The claims of an ID token the provider handed us directly over TLS: read, not verified. */
function idClaims(idToken: unknown): Record<string, unknown> {
  if (typeof idToken !== 'string') return {};
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export class AccountStore {
  private readonly db: Db;
  private readonly bus: Bus;
  private readonly fetch: Fetch;
  private readonly flows = new Map<string, Flow>();
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<MintResult>>();
  /** opened secrets, so DPAPI is not asked on every refresh */
  private readonly opened = new Map<string, string>();
  /** Told when an account needs the operator: a toast is said here, a push is for the daemon to add. */
  onNeedsReconsent: ((a: Account) => void) | null = null;

  constructor(db: Db, bus: Bus, opts: { fetch?: Fetch } = {}) {
    this.db = db;
    this.bus = bus;
    this.fetch = opts.fetch ?? fetch;
  }

  // ------------------------------------------------------------------ apps

  private appRow(provider: Provider): AppRow | undefined {
    return this.db.get<AppRow>('SELECT * FROM account_apps WHERE provider = ?', provider);
  }

  /** Whether a provider is offered at all: its app is configured (and for Google, has its secret). */
  enabled(provider: Provider): boolean {
    const a = this.appRow(provider);
    return !!a && !!a.client_id && (provider !== 'google' || !!a.secret);
  }

  /** The redirect URIs to register for a provider: this desk's loopback and the hub's https address. */
  redirectUris(provider: Provider, hubUrl: string | null): string[] {
    const uris = [`http://localhost:${PORT}${oauthCallbackPath(provider)}`];
    if (hubUrl && /^https:\/\//.test(hubUrl)) uris.push(`${hubUrl.replace(/\/+$/, '')}${oauthCallbackPath(provider)}`);
    return uris;
  }

  apps(hubUrl: string | null): AccountApp[] {
    return PROVIDERS.map((provider) => {
      const r = this.appRow(provider);
      return {
        provider,
        configured: this.enabled(provider),
        clientId: r?.client_id ?? null,
        tenant: r?.tenant ?? null,
        hasSecret: !!r?.secret,
        redirectUris: this.redirectUris(provider, hubUrl),
      };
    });
  }

  googleClientId(): string | null {
    return this.enabled('google') ? (this.appRow('google')?.client_id ?? null) : null;
  }

  microsoftClientId(): string | null {
    return this.enabled('microsoft') ? (this.appRow('microsoft')?.client_id ?? null) : null;
  }

  async saveApp(provider: Provider, input: { clientId?: unknown; clientSecret?: unknown; tenant?: unknown }): Promise<AccountApp> {
    if (!PROVIDERS.includes(provider)) throw httpError(400, 'Unknown provider');
    const existing = this.appRow(provider);
    const clientId = str(input.clientId) ?? existing?.client_id ?? null;
    if (!clientId) throw httpError(400, 'A client ID is required');
    if (provider === 'google' && !/\.apps\.googleusercontent\.com$/.test(clientId)) throw httpError(400, 'A Google client ID ends in .apps.googleusercontent.com');
    if (provider === 'microsoft' && !/^[0-9a-f-]{36}$/i.test(clientId)) throw httpError(400, 'A Microsoft client ID is the application (client) ID, a GUID');
    let secret = existing?.secret ?? null;
    let sealed = existing?.sealed ?? 0;
    const plain = str(input.clientSecret);
    if (plain) {
      const box = await protect(plain);
      secret = box ?? plain;
      sealed = box ? 1 : 0;
      this.opened.set(`app:${provider}`, plain);
    }
    if (provider === 'google' && !secret) throw httpError(400, 'The Google client secret is required');
    const tenant = str(input.tenant) ?? existing?.tenant ?? null;
    this.db.run(
      `INSERT INTO account_apps (provider, client_id, tenant, secret, sealed, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET client_id = excluded.client_id, tenant = excluded.tenant, secret = excluded.secret, sealed = excluded.sealed, updated_at = excluded.updated_at`,
      provider,
      clientId,
      tenant,
      provider === 'google' ? secret : null,
      provider === 'google' ? sealed : 0,
      now(),
    );
    // A different app cannot refresh tokens another app issued: every cached token is from the old one.
    if (existing && existing.client_id !== clientId) this.tokens.clear();
    log.info('saved an account app', { provider, clientId, sealed: sealed === 1 });
    this.bus.invalidate('state');
    return this.apps(null).find((a) => a.provider === provider)!;
  }

  removeApp(provider: Provider): void {
    this.db.run('DELETE FROM account_apps WHERE provider = ?', provider);
    this.opened.delete(`app:${provider}`);
    this.bus.invalidate('state');
  }

  private async open(key: string, value: string | null, sealed: number): Promise<string | null> {
    if (!value) return null;
    if (!sealed) return value;
    const hit = this.opened.get(key);
    if (hit) return hit;
    const plain = await unprotect(value);
    if (plain) this.opened.set(key, plain);
    return plain;
  }

  private async googleSecret(): Promise<string> {
    const r = this.appRow('google');
    const s = r ? await this.open('app:google', r.secret, r.sealed) : null;
    if (!s) throw httpError(500, 'The Google client secret could not be opened (sealed by another Windows user or machine?). Enter it again on the Accounts page.');
    return s;
  }

  // -------------------------------------------------------------- accounts

  private row(id: string): AccountRow | undefined {
    return this.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', id);
  }

  private dto(r: AccountRow): Account {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    return {
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      email: r.email,
      displayName: r.display_name,
      tenant: r.tenant,
      scopes: r.scopes.split(' ').filter(Boolean),
      status: r.status,
      lastError: r.last_error,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
      mints24h: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM account_mints WHERE account_id = ? AND ts >= ?', r.id, since)?.n ?? 0,
      server: accountServer(r.provider, r.id),
    };
  }

  list(): Account[] {
    return this.db.all<AccountRow>('SELECT * FROM accounts ORDER BY provider, email').map((r) => this.dto(r));
  }

  get(id: string): Account | null {
    const r = this.row(id);
    return r ? this.dto(r) : null;
  }

  snapshot(): AccountsSnapshot {
    return { enabled: { google: this.enabled('google'), microsoft: this.enabled('microsoft') }, accounts: this.list() };
  }

  /** An account by id or email, for sb_new_session, which an agent fills in from what it sees. */
  find(ref: string): AccountRow | undefined {
    const r = ref.trim().toLowerCase();
    return this.row(r) ?? this.db.get<AccountRow>('SELECT * FROM accounts WHERE lower(email) = ?', r);
  }

  private uniqueId(base: string): string {
    let id = validAccountId(base) ? base : 'account';
    for (let n = 2; this.row(id); n++) id = `${base}-${n}`.slice(0, 32);
    return id;
  }

  /** Rename an account; its sessions pick the new server name up when they next start. */
  rename(id: string, next: string): Account {
    const r = this.row(id);
    if (!r) throw httpError(404, 'Unknown account');
    const to = next.trim().toLowerCase();
    if (to === id) return this.dto(r);
    if (!validAccountId(to)) throw httpError(400, 'An account id is lowercase letters, digits and dashes, up to 32 characters');
    if (this.row(to)) throw httpError(409, `There is already an account called ${to}`);
    this.db.run('UPDATE accounts SET id = ?, updated_at = ? WHERE id = ?', to, now(), id);
    this.db.run('UPDATE run_accounts SET account_id = ? WHERE account_id = ?', to, id);
    this.db.run('UPDATE account_mints SET account_id = ? WHERE account_id = ?', to, id);
    const cached = this.tokens.get(id);
    if (cached) this.tokens.set(to, cached);
    this.tokens.delete(id);
    this.bus.invalidate('state');
    return this.dto(this.row(to)!);
  }

  /** Forget an account: revoked at Google; Microsoft has no per-app revoke for a public client. */
  async remove(id: string): Promise<void> {
    const r = this.row(id);
    if (!r) throw httpError(404, 'Unknown account');
    if (r.provider === 'google') {
      const token = await this.open(`acct:${id}`, r.refresh_token, r.sealed).catch(() => null);
      if (token) {
        await this.fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch((err: unknown) =>
          log.warn('could not revoke a Google token; it is forgotten here anyway', { account: id, error: err instanceof Error ? err.message : err }),
        );
      }
    }
    this.db.run('DELETE FROM accounts WHERE id = ?', id);
    this.db.run('DELETE FROM run_accounts WHERE account_id = ?', id);
    this.tokens.delete(id);
    this.opened.delete(`acct:${id}`);
    log.info('removed an account', { account: id, provider: r.provider, email: r.email });
    this.bus.invalidate('state');
  }

  // ----------------------------------------------------------- signing in

  /**
   * The redirect URI for a sign-in started from `origin`: the loopback address registered for this
   * desk when the browser is on it, the hub's https address when it came through the proxy.
   */
  redirectFor(provider: Provider, origin: string): string {
    const u = new URL(origin);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]') return `http://localhost:${PORT}${oauthCallbackPath(provider)}`;
    return `${u.protocol}//${u.host}${oauthCallbackPath(provider)}`;
  }

  /** The URL to send the browser to for signing an account in (or reconnecting one). */
  start(input: { provider: Provider; kind?: AccountKind; accountId?: string | null; origin: string }): { url: string } {
    const { provider } = input;
    if (!this.enabled(provider)) throw httpError(409, `Configure the ${provider === 'google' ? 'Google' : 'Microsoft'} app on the Accounts page first.`);
    const existing = input.accountId ? this.row(input.accountId) : undefined;
    if (input.accountId && !existing) throw httpError(404, 'Unknown account');
    const kind: AccountKind = existing?.kind ?? (provider === 'google' ? 'gmail' : input.kind === 'work' ? 'work' : 'personal');
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const redirectUri = this.redirectFor(provider, input.origin);
    for (const [k, f] of this.flows) if (f.expires < Date.now()) this.flows.delete(k);
    this.flows.set(state, { provider, kind, verifier, redirectUri, accountId: existing?.id ?? null, expires: Date.now() + FLOW_TTL_MS });
    const clientId = this.appRow(provider)!.client_id;
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256' });
    if (existing) q.set('login_hint', existing.email);
    if (provider === 'google') {
      q.set('scope', GOOGLE_SCOPES.join(' '));
      q.set('access_type', 'offline');
      // Always, so a refresh token comes back even for an account that consented before.
      q.set('prompt', 'consent');
      q.set('include_granted_scopes', 'true');
      return { url: `${GOOGLE_AUTH}?${q}` };
    }
    q.set('scope', msScopes(kind).join(' '));
    q.set('response_mode', 'query');
    if (!existing) q.set('prompt', 'select_account');
    return { url: `${MS_LOGIN}/${msAuthority(kind, existing?.tenant ?? null)}/oauth2/v2.0/authorize?${q}` };
  }

  /** Where the provider sends the browser back to. Returns the account added or reconnected. */
  async callback(provider: Provider, query: URLSearchParams): Promise<Account> {
    const state = query.get('state') ?? '';
    const flow = this.flows.get(state);
    this.flows.delete(state);
    if (!flow || flow.provider !== provider || flow.expires < Date.now()) throw httpError(400, 'This sign-in has expired or was already used. Start it again from the Accounts page.');
    const error = query.get('error');
    if (error) throw httpError(400, `${provider === 'google' ? 'Google' : 'Microsoft'} said: ${query.get('error_description') ?? error}`);
    const code = query.get('code');
    if (!code) throw httpError(400, 'No authorization code came back');
    const clientId = this.appRow(provider)?.client_id;
    if (!clientId) throw httpError(409, 'The app was removed while signing in');
    const form: Record<string, string> = {
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    };
    let tokenUrl = GOOGLE_TOKEN;
    if (provider === 'google') form.client_secret = await this.googleSecret();
    else {
      form.scope = msScopes(flow.kind).join(' ');
      tokenUrl = `${MS_LOGIN}/${msAuthority(flow.kind, null)}/oauth2/v2.0/token`;
    }
    const tok = await this.tokenRequest(tokenUrl, form);
    const refresh = str(tok.refresh_token);
    if (!refresh) throw httpError(502, 'The provider gave no refresh token. Remove the app from your account\'s connected apps and sign in again.');
    const claims = idClaims(tok.id_token);
    const subject = str(provider === 'google' ? claims.sub : claims.oid) ?? str(claims.sub);
    const email = (str(claims.email) ?? str(claims.preferred_username) ?? '').toLowerCase();
    if (!subject || !email) throw httpError(502, 'The provider did not say who signed in');
    const tid = str(claims.tid);
    const kind: AccountKind = provider === 'google' ? (str(claims.hd) ? 'workspace' : 'gmail') : tid === MS_CONSUMER_TENANT ? 'personal' : flow.kind === 'personal' && tid ? 'work' : flow.kind;
    const tenant = provider === 'microsoft' ? (kind === 'personal' ? 'consumers' : tid) : null;
    const scopes = str(tok.scope) ?? (provider === 'google' ? GOOGLE_SCOPES.join(' ') : msScopes(kind).join(' '));
    const box = await protect(refresh);
    const existing = flow.accountId ? this.row(flow.accountId) : this.db.get<AccountRow>('SELECT * FROM accounts WHERE provider = ? AND subject = ?', provider, subject);
    const ts = now();
    let id: string;
    if (existing) {
      if (existing.subject !== subject) throw httpError(409, `You signed in as ${email}, but this account is ${existing.email}. Reconnect with that account.`);
      id = existing.id;
      this.db.run(
        `UPDATE accounts SET kind = ?, email = ?, display_name = ?, tenant = ?, scopes = ?, refresh_token = ?, sealed = ?, status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?`,
        kind,
        email,
        str(claims.name),
        tenant,
        scopes,
        box ?? refresh,
        box ? 1 : 0,
        ts,
        id,
      );
    } else {
      id = this.uniqueId(accountIdFrom(email));
      this.db.run(
        `INSERT INTO accounts (id, provider, kind, email, display_name, subject, tenant, scopes, refresh_token, sealed, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
        id,
        provider,
        kind,
        email,
        str(claims.name),
        subject,
        tenant,
        scopes,
        box ?? refresh,
        box ? 1 : 0,
        ts,
        ts,
      );
    }
    this.opened.set(`acct:${id}`, refresh);
    const access = str(tok.access_token);
    if (access) this.tokens.set(id, { accessToken: access, expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000 });
    log.info(existing ? 'reconnected an account' : 'added an account', { account: id, provider, kind, email });
    this.bus.toast('info', `${email} ${existing ? 'is reconnected' : 'is added'}.`);
    this.bus.invalidate('state');
    return this.dto(this.row(id)!);
  }

  private async tokenRequest(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = String(body.error ?? res.status);
      throw Object.assign(new Error(`${err}: ${String(body.error_description ?? '').split('\n')[0]}`.trim()), { status: res.status >= 500 ? 502 : 400, oauthError: err });
    }
    return body;
  }

  // --------------------------------------------------------------- tokens

  /** A fresh access token for an account, from the cache or by refreshing. */
  async accessToken(id: string): Promise<MintResult & { cached: boolean }> {
    const cached = this.tokens.get(id);
    if (cached && cached.expiresAt - Date.now() > TOKEN_MARGIN_MS) return { ...cached, cached: true };
    let p = this.inflight.get(id);
    if (!p) {
      p = this.refresh(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return { ...(await p), cached: false };
  }

  private async refresh(id: string): Promise<MintResult> {
    const r = this.row(id);
    if (!r) throw httpError(404, 'Unknown account');
    if (!this.enabled(r.provider)) throw httpError(409, `The ${r.provider} app is not configured`);
    const token = await this.open(`acct:${id}`, r.refresh_token, r.sealed);
    if (!token) throw httpError(500, `${r.email}: its refresh token could not be opened. Reconnect it on the Accounts page.`);
    const clientId = this.appRow(r.provider)!.client_id;
    const form: Record<string, string> = { client_id: clientId, grant_type: 'refresh_token', refresh_token: token };
    let url = GOOGLE_TOKEN;
    if (r.provider === 'google') form.client_secret = await this.googleSecret();
    else {
      form.scope = r.scopes.split(' ').filter((s) => s && s !== 'openid' && s !== 'profile' && s !== 'email').join(' ') || msScopes(r.kind).join(' ');
      url = `${MS_LOGIN}/${msAuthority(r.kind, r.tenant)}/oauth2/v2.0/token`;
    }
    let tok: Record<string, unknown>;
    try {
      tok = await this.tokenRequest(url, form);
    } catch (err) {
      const oauthError = (err as { oauthError?: string }).oauthError;
      const message = err instanceof Error ? err.message : String(err);
      // The grant is gone: revoked, expired, password changed. Only the operator can bring it back.
      if (oauthError === 'invalid_grant' || oauthError === 'interaction_required' || oauthError === 'consent_required') {
        this.db.run("UPDATE accounts SET status = 'needs-reconsent', last_error = ?, updated_at = ? WHERE id = ?", message.slice(0, 500), now(), id);
        this.tokens.delete(id);
        const a = this.dto(this.row(id)!);
        log.warn('an account needs to be reconnected', { account: id, error: message });
        this.bus.toast('warn', `${r.email} needs to be reconnected on the Accounts page (${oauthError}).`);
        this.onNeedsReconsent?.(a);
        this.bus.invalidate('state');
        throw httpError(401, `${r.email} needs to be reconnected in Switchboard (Accounts page): ${message}`);
      }
      this.db.run("UPDATE accounts SET last_error = ?, updated_at = ? WHERE id = ?", message.slice(0, 500), now(), id);
      throw err;
    }
    const access = str(tok.access_token);
    if (!access) throw httpError(502, 'The provider returned no access token');
    // Microsoft hands out a new refresh token on every use: the newest is the one to keep.
    const rotated = str(tok.refresh_token);
    if (rotated && rotated !== token) {
      const box = await protect(rotated);
      this.db.run('UPDATE accounts SET refresh_token = ?, sealed = ? WHERE id = ?', box ?? rotated, box ? 1 : 0, id);
      this.opened.set(`acct:${id}`, rotated);
    }
    if (r.status !== 'ok') {
      this.db.run("UPDATE accounts SET status = 'ok', last_error = NULL WHERE id = ?", id);
      this.bus.invalidate('state');
    }
    const result = { accessToken: access, expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000 };
    this.tokens.set(id, result);
    return result;
  }

  /** Check an account works: a token, and who it belongs to. */
  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    const r = this.row(id);
    if (!r) throw httpError(404, 'Unknown account');
    try {
      const { accessToken } = await this.accessToken(id);
      const url = r.provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me';
      const res = await this.fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return { ok: false, detail: `${res.status}: ${JSON.stringify(body).slice(0, 200)}` };
      const who = str(body.email) ?? str(body.mail) ?? str(body.userPrincipalName) ?? r.email;
      return { ok: true, detail: `Signed in as ${who}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // ------------------------------------------------------- sessions' side

  runAccounts(runId: string): RunAccount[] {
    return this.db
      .all<AccountRow>('SELECT a.* FROM run_accounts ra JOIN accounts a ON a.id = ra.account_id WHERE ra.run_id = ? ORDER BY a.provider, a.email', runId)
      .map((a) => ({ id: a.id, provider: a.provider, kind: a.kind, email: a.email, server: accountServer(a.provider, a.id), status: a.status }));
  }

  /** Accounts as a request names them (ids or emails), checked: they must exist and be usable. */
  resolveRefs(refs: unknown): string[] {
    if (refs === undefined || refs === null) return [];
    if (!Array.isArray(refs)) throw httpError(400, 'accounts must be a list of account ids or emails');
    const out: string[] = [];
    for (const ref of refs) {
      if (typeof ref !== 'string' || !ref.trim()) continue;
      const a = this.find(ref);
      if (!a) throw httpError(400, `Unknown account: ${ref}`);
      if (!this.enabled(a.provider)) throw httpError(409, `${a.email}: the ${a.provider} app is not configured`);
      if (!out.includes(a.id)) out.push(a.id);
    }
    return out;
  }

  setRunAccounts(runId: string, ids: string[]): void {
    this.db.run('DELETE FROM run_accounts WHERE run_id = ?', runId);
    for (const id of ids) this.db.run('INSERT OR IGNORE INTO run_accounts (run_id, account_id) VALUES (?, ?)', runId, id);
    this.bus.invalidate('state');
  }

  /** A new ticket for a run's MCP servers; only its hash is kept, on the run. */
  issueTicket(runId: string): string {
    // Starts with a letter: a ticket beginning with "--" would read as an option on a command line.
    const ticket = `t${b64url(crypto.randomBytes(24))}`;
    this.db.run('UPDATE runs SET account_ticket_hash = ? WHERE id = ?', sha256(ticket), runId);
    return ticket;
  }

  /**
   * An access token for a session: the ticket says which run, and the run must be live, on the desk
   * asking, and have the account. Every one handed out is recorded.
   */
  async mintForRun(input: { ticket: unknown; account: unknown; deskId: string | null }): Promise<MintResult> {
    const ticket = typeof input.ticket === 'string' ? input.ticket : '';
    const accountRef = typeof input.account === 'string' ? input.account : '';
    if (!ticket || !accountRef) throw httpError(400, 'ticket and account are required');
    const run = this.db.get<{ id: string; desk_id: string | null; status: string }>('SELECT id, desk_id, status FROM runs WHERE account_ticket_hash = ?', sha256(ticket));
    if (!run || run.status === 'exited') throw httpError(403, 'This session cannot have account tokens (unknown or ended session)');
    const runDesk = run.desk_id && run.desk_id !== 'local' ? run.desk_id : null;
    if ((input.deskId ?? null) !== runDesk) throw httpError(403, 'This session runs on another desk');
    const account = this.find(accountRef.replace(/^(google|ms)-/, ''));
    if (!account || !this.db.get('SELECT 1 FROM run_accounts WHERE run_id = ? AND account_id = ?', run.id, account.id)) {
      throw httpError(403, `This session was not started with the account ${accountRef}`);
    }
    if (account.status === 'needs-reconsent') throw httpError(401, `${account.email} needs to be reconnected in Switchboard (Accounts page).`);
    const t = await this.accessToken(account.id);
    this.db.run('INSERT INTO account_mints (ts, account_id, run_id, desk_id, cached) VALUES (?, ?, ?, ?, ?)', now(), account.id, run.id, runDesk, t.cached ? 1 : 0);
    this.db.run('UPDATE accounts SET last_used_at = ? WHERE id = ?', now(), account.id);
    return { accessToken: t.accessToken, expiresAt: t.expiresAt };
  }

  prune(): void {
    const cutoff = new Date(Date.now() - MINT_RETENTION_DAYS * 86400_000).toISOString();
    this.db.run('DELETE FROM account_mints WHERE ts < ?', cutoff);
    this.db.run('DELETE FROM run_accounts WHERE run_id NOT IN (SELECT id FROM runs)');
  }
}
