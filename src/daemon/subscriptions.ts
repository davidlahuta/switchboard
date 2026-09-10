import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME_CLAUDE_DIR, HOME_CLAUDE_JSON, IS_WINDOWS, PROFILES_DIR, VERSION } from '../config.ts';
import { logger } from '../log.ts';
import type { Subscription, SubscriptionKind, SubscriptionStatus, Usage, UsagePoint } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import { claudeCommand, findClaude, readJson, writeJson } from './claude.ts';
import { bool, type Db, now } from './db.ts';
import type { Launcher } from './launcher.ts';
import { getSettings } from './settings.ts';

const log = logger('subscriptions');
const execFileP = promisify(execFile);

/** Folders shared with ~/.claude through junctions so sessions can resume across subscriptions. */
const SHARED_DIRS = ['projects', 'file-history', 'todos', 'plans', 'plugins', 'skills', 'agents', 'commands', 'output-styles'];
/** Files copied from ~/.claude when the source is newer. */
const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'];
/** ~/.claude.json keys worth carrying into a profile (onboarding state, MCP servers, preferences). */
const CLAUDE_JSON_KEYS = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'mcpServers',
  'theme',
  'hasIdeOnboardingBeenShown',
  'effortCalloutDismissed',
  'effortCalloutV2Dismissed',
  'opusProMigrationComplete',
  'sonnet1m45MigrationComplete',
  'officialMarketplaceAutoInstallAttempted',
  'officialMarketplaceAutoInstalled',
  'hasSeenTasksHint',
  'bypassPermissionsModeAccepted',
  'hasResetAutoModeOptInForDefaultOffer',
  'lastReleaseNotesSeen',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'remoteDialogSeen',
];

const OAUTH_API = process.env.SWITCHBOARD_OAUTH_API ?? 'https://api.anthropic.com';
const HISTORY_EVERY_MS = 5 * 60_000;
const LOGIN_WATCH_MS = 20 * 60_000;

interface SubRow {
  id: string;
  label: string;
  kind: SubscriptionKind;
  config_dir: string;
  email: string | null;
  display_name: string | null;
  plan: string | null;
  rate_tier: string | null;
  enabled: number;
  priority: number;
  status: SubscriptionStatus;
  last_error: string | null;
  usage_json: string | null;
  created_at: string;
}

interface Credentials {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

type OAuthWindow = { utilization?: number; resets_at?: string | null } | null | undefined;

export function weightFor(plan: string | null, tier: string | null): number {
  const m = tier?.match(/(\d+)x/);
  if (m) return Number(m[1]);
  if (plan === 'max') return 5;
  return 1;
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'sub'
  );
}

export class SubscriptionManager {
  private readonly db: Db;
  private readonly bus: Bus;
  private readonly launcher: Launcher;
  /** Provided by the run manager. */
  liveRunsFor: (subscriptionId: string) => number = () => 0;
  /** Called after each successful usage refresh. */
  onUsage: (sub: Subscription) => void = () => {};
  private readonly lastPoll = new Map<string, number>();
  private readonly lastHistory = new Map<string, number>();
  private readonly watchers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Db, bus: Bus, launcher: Launcher) {
    this.db = db;
    this.bus = bus;
    this.launcher = launcher;
  }

  start(): void {
    this.ensureDefault();
    for (const r of this.rows()) if (r.status === 'pending_login') this.watchLogin(r.id);
    this.timer = setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.watchers.values()) clearInterval(t);
  }

  // ---------------------------------------------------------------- reads

  private rows(): SubRow[] {
    return this.db.all<SubRow>('SELECT * FROM subscriptions ORDER BY priority DESC, created_at');
  }

  row(id: string): SubRow | undefined {
    return this.db.get<SubRow>('SELECT * FROM subscriptions WHERE id = ?', id);
  }

  private dto(r: SubRow): Subscription {
    let usage: Usage | null = null;
    try {
      usage = r.usage_json ? (JSON.parse(r.usage_json) as Usage) : null;
    } catch {
      usage = null;
    }
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      configDir: r.config_dir,
      email: r.email,
      displayName: r.display_name,
      plan: r.plan,
      rateTier: r.rate_tier,
      weight: weightFor(r.plan, r.rate_tier),
      enabled: bool(r.enabled),
      priority: r.priority,
      status: r.status,
      lastError: r.last_error,
      usage,
      liveRuns: this.liveRunsFor(r.id),
      createdAt: r.created_at,
    };
  }

  list(): Subscription[] {
    return this.rows().map((r) => this.dto(r));
  }

  get(id: string): Subscription | null {
    const r = this.row(id);
    return r ? this.dto(r) : null;
  }

  history(id: string, hours: number): UsagePoint[] {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return this.db
      .all<{ ts: string; five_hour_pct: number | null; seven_day_pct: number | null }>(
        'SELECT ts, five_hour_pct, seven_day_pct FROM usage_history WHERE subscription_id = ? AND ts >= ? ORDER BY ts',
        id,
        since,
      )
      .map((p) => ({ ts: p.ts, fiveHourPct: p.five_hour_pct, sevenDayPct: p.seven_day_pct }));
  }

  /** Environment overrides that point claude at this subscription. */
  envFor(id: string): Record<string, string | null> {
    const r = this.row(id);
    if (!r) throw new Error(`unknown subscription ${id}`);
    return { CLAUDE_CONFIG_DIR: r.kind === 'default' ? null : r.config_dir };
  }

  /**
   * Best subscription to move work to: most absolute headroom (plan weight × remaining %),
   * discounted by how many sessions already run on it.
   */
  pickBest(excludeId?: string | null): SubRow | null {
    const threshold = getSettings(this.db).swapThresholdPct;
    let best: { row: SubRow; score: number } | null = null;
    for (const r of this.rows()) {
      if (r.id === excludeId || !bool(r.enabled) || r.status !== 'ready') continue;
      const u = this.dto(r).usage;
      const used = Math.max(u?.fiveHour?.pct ?? 40, u?.sevenDay?.pct ?? 40);
      if (used >= Math.min(99, threshold)) continue;
      const remaining = ((100 - used) / 100) * weightFor(r.plan, r.rate_tier);
      const score = remaining / (1 + 0.5 * this.liveRunsFor(r.id)) + r.priority * 0.01;
      if (!best || score > best.score) best = { row: r, score };
    }
    return best?.row ?? null;
  }

  // ------------------------------------------------------------- profiles

  ensureDefault(): void {
    if (this.db.get("SELECT 1 FROM subscriptions WHERE kind = 'default'")) return;
    if (!fs.existsSync(path.join(HOME_CLAUDE_DIR, '.credentials.json'))) return;
    this.db.run(
      "INSERT INTO subscriptions (id, label, kind, config_dir, status, enabled, priority, created_at) VALUES ('default', 'Default (~/.claude)', 'default', ?, 'ready', 1, 0, ?)",
      HOME_CLAUDE_DIR,
      now(),
    );
    void this.refreshIdentity('default');
  }

  private prepareProfile(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SHARED_DIRS) {
      const target = path.join(HOME_CLAUDE_DIR, name);
      const link = path.join(dir, name);
      fs.mkdirSync(target, { recursive: true });
      try {
        fs.lstatSync(link);
        continue; // exists already
      } catch {
        // create below
      }
      try {
        fs.symlinkSync(target, link, IS_WINDOWS ? 'junction' : 'dir');
      } catch (err) {
        log.warn(`could not link ${name} into profile; sessions may not resume across subscriptions`, err instanceof Error ? err.message : err);
        fs.mkdirSync(link, { recursive: true });
      }
    }
    this.copySharedFiles(dir, true);
    const profileJson = path.join(dir, '.claude.json');
    if (!fs.existsSync(profileJson)) writeJson(profileJson, { ...this.homeClaudeJsonSubset(), hasCompletedOnboarding: true });
  }

  private copySharedFiles(dir: string, force: boolean): void {
    for (const f of SHARED_FILES) {
      const src = path.join(HOME_CLAUDE_DIR, f);
      const dst = path.join(dir, f);
      try {
        const s = fs.statSync(src);
        let copy = force;
        if (!copy) {
          try {
            copy = s.mtimeMs > fs.statSync(dst).mtimeMs;
          } catch {
            copy = true;
          }
        }
        if (copy) fs.copyFileSync(src, dst);
      } catch {
        // source missing: nothing to share
      }
    }
  }

  private homeClaudeJsonSubset(): Record<string, unknown> {
    const home = readJson<Record<string, unknown>>(HOME_CLAUDE_JSON) ?? {};
    const out: Record<string, unknown> = {};
    for (const k of CLAUDE_JSON_KEYS) if (home[k] !== undefined) out[k] = home[k];
    const projects = home.projects as Record<string, Record<string, unknown>> | undefined;
    if (projects) {
      out.projects = Object.fromEntries(
        Object.entries(projects).map(([p, v]) => [p, { hasTrustDialogAccepted: v.hasTrustDialogAccepted, mcpServers: v.mcpServers, enabledMcpjsonServers: v.enabledMcpjsonServers }]),
      );
    }
    return out;
  }

  /** Refresh shared settings/config in a profile before launching a session on it. */
  syncProfile(id: string): void {
    const r = this.row(id);
    if (!r || r.kind !== 'profile') return;
    this.prepareProfile(r.config_dir);
    this.copySharedFiles(r.config_dir, false);
    if (this.liveRunsFor(id) > 0) return; // don't race a running claude writing .claude.json
    const file = path.join(r.config_dir, '.claude.json');
    const profile = readJson<Record<string, unknown>>(file) ?? {};
    const subset = this.homeClaudeJsonSubset();
    const merged: Record<string, unknown> = { ...profile, ...subset };
    const pp = (profile.projects ?? {}) as Record<string, Record<string, unknown>>;
    const hp = (subset.projects ?? {}) as Record<string, Record<string, unknown>>;
    const projects: Record<string, Record<string, unknown>> = { ...pp };
    for (const [k, v] of Object.entries(hp)) {
      projects[k] = { ...(pp[k] ?? {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) };
      if (pp[k]?.hasTrustDialogAccepted) projects[k].hasTrustDialogAccepted = true;
    }
    merged.projects = projects;
    try {
      writeJson(file, merged);
    } catch (err) {
      log.warn('could not sync profile .claude.json', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Carry "I trust this folder" from one profile to another when a session moves between them.
   * Without it a swap can land in Claude Code's trust dialog, where the resume message would be
   * answered by the highlighted "No, exit".
   */
  propagateTrust(fromId: string, toId: string, dir: string): void {
    const from = this.row(fromId);
    const to = this.row(toId);
    if (!from || !to) return;
    const key = path.resolve(dir);
    const fromJson = readJson<{ projects?: Record<string, Record<string, unknown>> }>(path.join(from.config_dir, '.claude.json'));
    const trusted = fromJson?.projects?.[key]?.hasTrustDialogAccepted === true;
    if (!trusted) return;
    const file = path.join(to.config_dir, '.claude.json');
    const target = readJson<Record<string, any>>(file) ?? {};
    target.projects ??= {};
    target.projects[key] = { ...(target.projects[key] ?? {}), hasTrustDialogAccepted: true };
    try {
      writeJson(file, target);
    } catch (err) {
      log.warn('could not propagate folder trust', err instanceof Error ? err.message : err);
    }
  }

  // --------------------------------------------------------------- CRUD

  create(label: string, email?: string): Subscription {
    const clean = label.trim().slice(0, 60) || 'Subscription';
    const id = `${slug(clean)}-${crypto.randomBytes(2).toString('hex')}`;
    const dir = path.join(PROFILES_DIR, id);
    this.prepareProfile(dir);
    this.db.run(
      "INSERT INTO subscriptions (id, label, kind, config_dir, email, status, enabled, priority, created_at) VALUES (?, ?, 'profile', ?, ?, 'pending_login', 1, 0, ?)",
      id,
      clean,
      dir,
      email?.trim() || null,
      now(),
    );
    this.openLogin(id);
    this.bus.invalidate('state');
    return this.get(id)!;
  }

  update(id: string, patch: { label?: string; enabled?: boolean; priority?: number }): Subscription {
    const r = this.row(id);
    if (!r) throw Object.assign(new Error('not found'), { status: 404 });
    if (typeof patch.label === 'string' && patch.label.trim()) this.db.run('UPDATE subscriptions SET label = ? WHERE id = ?', patch.label.trim().slice(0, 60), id);
    if (typeof patch.enabled === 'boolean') this.db.run('UPDATE subscriptions SET enabled = ? WHERE id = ?', patch.enabled ? 1 : 0, id);
    if (typeof patch.priority === 'number' && Number.isFinite(patch.priority)) this.db.run('UPDATE subscriptions SET priority = ? WHERE id = ?', Math.round(patch.priority), id);
    this.bus.invalidate('state');
    return this.get(id)!;
  }

  remove(id: string, purge: boolean): void {
    const r = this.row(id);
    if (!r) return;
    if (r.kind === 'default') {
      throw Object.assign(new Error('The default login is re-imported from ~/.claude on every start. Disable it instead.'), { status: 400 });
    }
    if (this.liveRunsFor(id) > 0) throw Object.assign(new Error('Sessions are running on this subscription. Swap or stop them first.'), { status: 409 });
    this.db.run('DELETE FROM subscriptions WHERE id = ?', id);
    this.db.run('DELETE FROM usage_history WHERE subscription_id = ?', id);
    const w = this.watchers.get(id);
    if (w) clearInterval(w);
    if (purge && r.kind === 'profile') this.purgeProfile(r.config_dir);
    this.bus.invalidate('state');
  }

  /** Delete a profile folder without ever following its junctions into ~/.claude. */
  private purgeProfile(dir: string): void {
    const resolved = path.resolve(dir);
    if (!resolved.toLowerCase().startsWith(path.resolve(PROFILES_DIR).toLowerCase() + path.sep)) {
      throw new Error(`refusing to delete ${resolved}: not inside ${PROFILES_DIR}`);
    }
    if (!fs.existsSync(resolved)) return;
    for (const entry of fs.readdirSync(resolved)) {
      const p = path.join(resolved, entry);
      if (fs.lstatSync(p).isSymbolicLink()) {
        try {
          fs.rmdirSync(p);
        } catch {
          fs.unlinkSync(p);
        }
      }
    }
    for (const entry of fs.readdirSync(resolved)) {
      if (fs.lstatSync(path.join(resolved, entry)).isSymbolicLink()) throw new Error(`could not unlink ${entry}; aborting delete`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    log.info('profile deleted', { dir: resolved });
  }

  // ---------------------------------------------------------------- login

  openLogin(id: string): void {
    const r = this.row(id);
    if (!r) throw Object.assign(new Error('not found'), { status: 404 });
    const args = ['login-shell', '--config-dir', r.kind === 'default' ? 'default' : r.config_dir, '--label', r.label];
    if (r.email) args.push('--email', r.email);
    this.launcher.openTerminal({ title: `Switchboard login · ${r.label}`, cwd: os.homedir(), args });
    this.watchLogin(id);
  }

  private watchLogin(id: string): void {
    const existing = this.watchers.get(id);
    if (existing) clearInterval(existing);
    const started = Date.now();
    const credFile = (): string => path.join(this.row(id)?.config_dir ?? '', '.credentials.json');
    const timer = setInterval(async () => {
      const r = this.row(id);
      if (!r || Date.now() - started > LOGIN_WATCH_MS) {
        clearInterval(timer);
        this.watchers.delete(id);
        return;
      }
      try {
        const st = fs.statSync(credFile());
        if (r.status === 'ready' && st.mtimeMs < started) return;
        if (!this.readCredentials(r.config_dir)) return;
        clearInterval(timer);
        this.watchers.delete(id);
        await this.refreshIdentity(id);
        const s = this.get(id);
        this.bus.toast('info', `Logged in: ${s?.label} (${s?.email ?? 'unknown account'})`);
      } catch {
        // not yet
      }
    }, 2000);
    this.watchers.set(id, timer);
  }

  private readCredentials(dir: string): Credentials | null {
    const raw = readJson<{ claudeAiOauth?: Record<string, unknown> }>(path.join(dir, '.credentials.json'));
    const o = raw?.claudeAiOauth;
    if (!o || typeof o.accessToken !== 'string') return null;
    return {
      accessToken: o.accessToken,
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
      rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : null,
    };
  }

  /** Let the claude CLI refresh an expired token (it owns refresh-token rotation). */
  private async freshToken(r: SubRow): Promise<string | null> {
    let creds = this.readCredentials(r.config_dir);
    if (!creds) return null;
    if (!creds.expiresAt || creds.expiresAt - Date.now() > 60_000) return creds.accessToken;
    if (this.liveRunsFor(r.id) > 0) return null; // the running session will refresh it
    const claude = findClaude();
    if (!claude) return null;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (r.kind === 'default') delete env.CLAUDE_CONFIG_DIR;
      else env.CLAUDE_CONFIG_DIR = r.config_dir;
      const cmd = claudeCommand(claude, ['auth', 'status', '--json']);
      await execFileP(cmd.file, cmd.args, { env, timeout: 30_000, windowsHide: true });
    } catch (err) {
      log.debug('auth status failed', err instanceof Error ? err.message : err);
    }
    creds = this.readCredentials(r.config_dir);
    return creds && (!creds.expiresAt || creds.expiresAt > Date.now()) ? creds.accessToken : null;
  }

  private async oauthGet(token: string, pathname: string): Promise<Response> {
    return fetch(`${OAUTH_API}${pathname}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `switchboard/${VERSION}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  async refreshIdentity(id: string): Promise<void> {
    const r = this.row(id);
    if (!r) return;
    const creds = this.readCredentials(r.config_dir);
    if (!creds) {
      this.db.run("UPDATE subscriptions SET status = 'logged_out', last_error = 'no credentials' WHERE id = ?", id);
      this.bus.invalidate('state');
      return;
    }
    this.db.run("UPDATE subscriptions SET plan = ?, rate_tier = ?, status = 'ready', last_error = NULL WHERE id = ?", creds.subscriptionType, creds.rateLimitTier, id);
    const token = await this.freshToken(r);
    if (token) {
      try {
        const res = await this.oauthGet(token, '/api/oauth/profile');
        if (res.ok) {
          const p = (await res.json()) as { account?: { email?: string; display_name?: string; full_name?: string } };
          const email = p.account?.email ?? null;
          this.db.run('UPDATE subscriptions SET email = COALESCE(?, email), display_name = ? WHERE id = ?', email, p.account?.display_name ?? p.account?.full_name ?? null, id);
          const dup = email ? this.db.get<{ label: string }>('SELECT label FROM subscriptions WHERE id <> ? AND lower(email) = lower(?)', id, email) : undefined;
          if (dup) {
            this.db.run('UPDATE subscriptions SET last_error = ? WHERE id = ?', `Same account as "${dup.label}"`, id);
            this.bus.toast('warn', `${r.label} is logged into the same account as ${dup.label}.`);
          }
        }
      } catch (err) {
        log.warn('profile fetch failed', err instanceof Error ? err.message : err);
      }
    }
    this.bus.invalidate('state');
    await this.poll(id, true);
  }

  // ---------------------------------------------------------------- usage

  private async tick(): Promise<void> {
    const pollSec = getSettings(this.db).usagePollSec;
    for (const r of this.rows()) {
      if (r.status === 'pending_login') continue;
      const interval = (this.liveRunsFor(r.id) > 0 ? pollSec : Math.max(pollSec * 5, 600)) * 1000;
      if (Date.now() - (this.lastPoll.get(r.id) ?? 0) >= interval) await this.poll(r.id, false);
    }
  }

  async poll(id: string, force: boolean): Promise<Subscription | null> {
    const r = this.row(id);
    if (!r || r.status === 'pending_login' || this.inFlight.has(id)) return this.get(id);
    if (!force && Date.now() - (this.lastPoll.get(id) ?? 0) < 20_000) return this.get(id);
    this.inFlight.add(id);
    this.lastPoll.set(id, Date.now());
    try {
      const creds = this.readCredentials(r.config_dir);
      if (!creds) {
        this.db.run("UPDATE subscriptions SET status = 'logged_out', last_error = 'Not logged in' WHERE id = ?", id);
        return this.get(id);
      }
      const token = await this.freshToken(r);
      if (!token) {
        this.markStale(r, 'Token expired; it refreshes when a session runs on this subscription.');
        return this.get(id);
      }
      const res = await this.oauthGet(token, '/api/oauth/usage');
      if (res.status === 401) {
        this.db.run("UPDATE subscriptions SET status = 'logged_out', last_error = 'Login expired (401). Re-login.' WHERE id = ?", id);
        return this.get(id);
      }
      if (!res.ok) {
        this.markStale(r, `Usage endpoint returned HTTP ${res.status}`);
        return this.get(id);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const win = (w: OAuthWindow) => (w && typeof w.utilization === 'number' ? { pct: w.utilization, resetsAt: w.resets_at ?? null } : null);
      const limits = Array.isArray(json.limits) ? (json.limits as Array<Record<string, any>>) : [];
      const usage: Usage = {
        fiveHour: win(json.five_hour as OAuthWindow),
        sevenDay: win(json.seven_day as OAuthWindow),
        scoped: limits
          .filter((l) => l.kind === 'weekly_scoped' && typeof l.percent === 'number')
          .map((l) => ({ label: String(l.scope?.model?.display_name ?? l.scope?.surface ?? 'scoped'), pct: l.percent as number, resetsAt: (l.resets_at as string) ?? null })),
        fetchedAt: now(),
        source: 'oauth',
        stale: false,
        error: null,
      };
      this.db.run(
        "UPDATE subscriptions SET usage_json = ?, status = 'ready', last_error = CASE WHEN last_error LIKE 'Same account%' THEN last_error ELSE NULL END, plan = COALESCE(?, plan), rate_tier = COALESCE(?, rate_tier) WHERE id = ?",
        JSON.stringify(usage),
        creds.subscriptionType,
        creds.rateLimitTier,
        id,
      );
      if (Date.now() - (this.lastHistory.get(id) ?? 0) >= HISTORY_EVERY_MS) {
        this.lastHistory.set(id, Date.now());
        this.db.run(
          'INSERT INTO usage_history (subscription_id, ts, five_hour_pct, seven_day_pct) VALUES (?, ?, ?, ?)',
          id,
          usage.fetchedAt,
          usage.fiveHour?.pct ?? null,
          usage.sevenDay?.pct ?? null,
        );
      }
      const sub = this.get(id)!;
      this.onUsage(sub);
      return sub;
    } catch (err) {
      this.markStale(r, err instanceof Error ? err.message : String(err));
      return this.get(id);
    } finally {
      this.inFlight.delete(id);
      this.bus.invalidate('state');
    }
  }

  private markStale(r: SubRow, error: string): void {
    let usage: Usage | null = null;
    try {
      usage = r.usage_json ? (JSON.parse(r.usage_json) as Usage) : null;
    } catch {
      usage = null;
    }
    const next: Usage = usage
      ? { ...usage, stale: true, error }
      : { fiveHour: null, sevenDay: null, scoped: [], fetchedAt: now(), source: 'oauth', stale: true, error };
    this.db.run('UPDATE subscriptions SET usage_json = ? WHERE id = ?', JSON.stringify(next), r.id);
  }
}
