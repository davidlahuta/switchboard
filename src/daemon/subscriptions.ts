import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME_CLAUDE_DIR, HOME_CLAUDE_JSON, IS_WINDOWS, PROFILES_DIR, SPAWN_CWD, VERSION, withoutParentSession } from '../config.ts';
import { logger } from '../log.ts';
import type { Subscription, SubscriptionKind, SubscriptionStatus, Usage, UsagePoint } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import { claudeCommand, findClaude, mcpServerEntry, readJson, writeJson } from './claude.ts';
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

/** Utilisation assumed for a window that has not reported yet (no session has run on it). */
const ASSUMED_PCT = 40;
/** A subscription at or past this has nothing left to give, whatever the proactive threshold says. */
export const SPENT_PCT = 99;
/** How close a spent window has to be to turning over before that is worth counting on. */
const RESET_SOON_MS = 15 * 60_000;
/**
 * How long before a token expires Switchboard renews it.
 *
 * Claude Code's tokens last about eight hours and the CLI renews them on the next API call it
 * makes — which is fine for a session that is working and no use at all for one sitting at a
 * prompt, or for a subscription with nothing running on it. Renewing early rather than at the
 * cliff edge also keeps Switchboard's renewal well clear of the moment a live session might do
 * its own; the CLI holds a lock across the refresh either way.
 */
const TOKEN_MARGIN_MS = 15 * 60_000;
/** No more than one renewal attempt per subscription in this window, whatever asks for a token. */
const RENEW_EVERY_MS = 60_000;
/** How long to leave a subscription alone after a renewal that did not take. */
const RENEW_BACKOFF_MS = 5 * 60_000;
/** How long a session stays away from a subscription it has just left, so it cannot bounce back. */
const RECENTLY_LEFT_MS = 30 * 60_000;
/**
 * How much better a subscription has to be before a session already running happily is moved to it.
 * A swap costs the session its turn and a resume, so trading that for a few points of headroom is a
 * bad deal twice: once making it, and again when the numbers cross back.
 */
export const SWAP_MARGIN = 1.25;

/**
 * What is actually usable right now. Both windows gate every request, so the tighter one decides;
 * scaling by plan weight makes a 20x Max at 80% outrank a Pro at 10%, which is what "most usage
 * available" means in tokens rather than percent.
 */
export function headroomOf(usage: Usage | null, weight: number): { headroom: number; bindingWindow: 'fiveHour' | 'sevenDay' | null } {
  const five = usage?.fiveHour?.pct ?? null;
  const seven = usage?.sevenDay?.pct ?? null;
  const used = Math.max(five ?? ASSUMED_PCT, seven ?? ASSUMED_PCT);
  const bindingWindow = five === null && seven === null ? null : (five ?? ASSUMED_PCT) >= (seven ?? ASSUMED_PCT) ? 'fiveHour' : 'sevenDay';
  return { headroom: Math.max(0, (100 - used) / 100) * weight, bindingWindow };
}

/**
 * How good a subscription is to put a session on, as a number only worth comparing with itself.
 *
 * The shape that matters is headroom shared with whoever is already there. Sessions burn at broadly
 * the same rate, so a subscription with two on it runs out in roughly a third of the time one with
 * none does, and how long a session gets before it has to move again is what decides how many times
 * it moves over its life. Everything else adjusts that:
 *
 * - A window minutes from turning over is about to hand its capacity back, and passing it over for
 *   somewhere with less to give over the next hour buys one swap now and another one soon.
 * - A subscription this session has just left is avoided, because two subscriptions drifting either
 *   side of each other will otherwise pass a session back and forth all day.
 */
export function subscriptionScore(input: {
  headroom: number;
  /** what its headroom becomes once the binding window resets */
  fullHeadroom: number;
  liveRuns: number;
  priority: number;
  resetsInMs: number | null;
  recentlyLeft: boolean;
}): number {
  const share = (h: number): number => h / (1 + 0.5 * input.liveRuns);
  let score = share(input.headroom);
  if (input.resetsInMs !== null && input.resetsInMs <= RESET_SOON_MS) {
    // Worth what it will be worth, less the wait: everything at the moment of the reset, nothing a
    // quarter of an hour out.
    const wait = Math.max(0, input.resetsInMs) / RESET_SOON_MS;
    score = Math.max(score, share(input.fullHeadroom) * (1 - wait));
  }
  if (input.recentlyLeft) score *= 0.5;
  return score + input.priority * 0.01;
}

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
  /** Set when the usage endpoint returns 429. It rate-limits per account, so back everyone off. */
  private cooldownUntil = 0;
  private consecutive429 = 0;
  private lastRequestAt = 0;
  private readonly lastHistory = new Map<string, number>();
  private readonly watchers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  /** When each subscription's token may next be offered for renewal. See freshToken. */
  private readonly renewAfter = new Map<string, number>();
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
    const weight = weightFor(r.plan, r.rate_tier);
    const usable = bool(r.enabled) && r.status === 'ready';
    const { headroom, bindingWindow } = headroomOf(usage, weight);
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      configDir: r.config_dir,
      email: r.email,
      displayName: r.display_name,
      plan: r.plan,
      rateTier: r.rate_tier,
      weight,
      headroom: usable ? headroom : 0,
      bindingWindow: usable ? bindingWindow : null,
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
   * Best subscription to move work to, and what it scores, so a caller weighing a move it does not
   * have to make can see whether the move is worth it.
   *
   * `runId` lets the session's own history count: a subscription it has just been moved off is not
   * somewhere to send it straight back to.
   */
  rank(excludeId?: string | null, runId?: string, atLimit = false): { row: SubRow; score: number } | null {
    // A session that is already stopped is not weighing a move against staying — it has nothing to
    // stay on. So the proactive threshold steps aside and only a spent subscription is refused.
    const threshold = atLimit ? SPENT_PCT : getSettings(this.db).swapThresholdPct;
    const left = runId ? this.recentlyLeft(runId) : new Set<string>();
    let best: { row: SubRow; score: number } | null = null;
    for (const r of this.rows()) {
      if (r.id === excludeId) continue;
      const sub = this.dto(r);
      if (!sub.enabled || sub.status !== 'ready') continue;
      const used = Math.max(sub.usage?.fiveHour?.pct ?? ASSUMED_PCT, sub.usage?.sevenDay?.pct ?? ASSUMED_PCT);
      if (used >= Math.min(SPENT_PCT, threshold)) continue;
      const score = subscriptionScore({
        headroom: sub.headroom,
        fullHeadroom: weightFor(r.plan, r.rate_tier),
        liveRuns: this.liveRunsFor(r.id),
        priority: r.priority,
        resetsInMs: this.resetsInMs(sub),
        recentlyLeft: left.has(r.id),
      });
      if (!best || score > best.score) best = { row: r, score };
    }
    return best;
  }

  pickBest(excludeId?: string | null, runId?: string, atLimit = false): SubRow | null {
    return this.rank(excludeId, runId, atLimit)?.row ?? null;
  }

  /** How much of the binding window a subscription has spent, or the assumption when nothing is known. */
  usedPct(id: string): number {
    const r = this.row(id);
    const usage = r ? this.dto(r).usage : null;
    if (!usage) return ASSUMED_PCT;
    return Math.max(usage.fiveHour?.pct ?? ASSUMED_PCT, usage.sevenDay?.pct ?? ASSUMED_PCT);
  }

  /** What the subscription a session is on now is worth, to compare a proposed move against. */
  scoreOf(id: string): number {
    const r = this.row(id);
    if (!r) return 0;
    const sub = this.dto(r);
    return subscriptionScore({
      headroom: sub.headroom,
      fullHeadroom: weightFor(r.plan, r.rate_tier),
      liveRuns: Math.max(0, this.liveRunsFor(id) - 1), // not counting the session asking
      priority: r.priority,
      resetsInMs: this.resetsInMs(sub),
      recentlyLeft: false,
    });
  }

  /** Milliseconds until the window that is currently binding turns over, when that is known. */
  private resetsInMs(sub: Subscription): number | null {
    const five = sub.usage?.fiveHour ?? null;
    const seven = sub.usage?.sevenDay ?? null;
    const binding = (five?.pct ?? 0) >= (seven?.pct ?? 0) ? five : seven;
    if (!binding?.resetsAt) return null;
    return Date.parse(binding.resetsAt) - Date.now();
  }

  /** Subscriptions this session has been moved off recently. */
  private recentlyLeft(runId: string): Set<string> {
    const since = new Date(Date.now() - RECENTLY_LEFT_MS).toISOString();
    const rows = this.db.all<{ from_sub: string | null }>('SELECT DISTINCT from_sub FROM swaps WHERE run_id = ? AND ts >= ?', runId, since);
    return new Set(rows.map((r) => r.from_sub).filter((x): x is string => !!x));
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
  /**
   * Make sure a profile knows where Switchboard's MCP server lives.
   *
   * Sessions are launched asking for a channel on "server:switchboard", and that name is looked up
   * among the servers the profile has registered — passing the same definition on the command line
   * with --mcp-config does not answer it. The registration reaches a profile through syncProfile,
   * which declines to write while any session on that subscription is running rather than race a
   * live claude rewriting the same file, so a subscription that is never idle never got it.
   *
   * This writes the one key, on its own, whatever else is going on. The race it accepts is losing
   * that key again when a running claude next rewrites the file, which the next spawn puts back.
   */
  ensureMcpRegistered(id: string): void {
    const r = this.row(id);
    const dir = r?.kind === 'profile' ? r.config_dir : HOME_CLAUDE_DIR;
    const file = path.join(dir, '.claude.json');
    try {
      const json = readJson<Record<string, unknown>>(file) ?? {};
      const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
      if (servers.switchboard) return;
      json.mcpServers = { ...servers, switchboard: mcpServerEntry() };
      writeJson(file, json);
      log.info('registered the MCP server in a profile that was missing it', { subscription: r?.label ?? id });
    } catch (err) {
      log.warn('could not register the MCP server in the profile', err instanceof Error ? err.message : err);
    }
  }

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
  /**
   * How Claude Code keys a directory in `.claude.json`: an absolute path with forward slashes,
   * even on Windows. Building the key with `path.resolve` alone produced backslashes, which
   * matched nothing — so folder trust silently never travelled, and every session on a profile
   * that had not seen the folder before stopped at the trust dialog.
   */
  private projectKey(dir: string): string {
    return path.resolve(dir).replace(/\\/g, '/');
  }

  /**
   * Mark a folder trusted for a subscription's profile.
   *
   * Choosing the folder in Switchboard is the trust decision; asking again once per profile only
   * moves that decision to a dialog nobody is at, in front of a session that has already been
   * launched. Recording it is also far safer than answering the dialog by keystroke: the option it
   * highlights is "No, exit", so a mistimed keypress kills the session.
   */
  trustFolder(subscriptionId: string, dir: string): void {
    const sub = this.row(subscriptionId);
    if (!sub) return;
    const key = this.projectKey(dir);
    const file = path.join(sub.config_dir, '.claude.json');
    const target = readJson<Record<string, any>>(file) ?? {};
    target.projects ??= {};
    if (target.projects[key]?.hasTrustDialogAccepted === true) return;
    target.projects[key] = { ...(target.projects[key] ?? {}), hasTrustDialogAccepted: true };
    try {
      writeJson(file, target);
      log.info('trusted folder for profile', { subscription: sub.label, dir: key });
    } catch (err) {
      log.warn('could not record folder trust', err instanceof Error ? err.message : err);
    }
  }

  propagateTrust(fromId: string, toId: string, dir: string): void {
    const from = this.row(fromId);
    if (!from) return;
    const key = this.projectKey(dir);
    const fromJson = readJson<{ projects?: Record<string, Record<string, unknown>> }>(path.join(from.config_dir, '.claude.json'));
    if (fromJson?.projects?.[key]?.hasTrustDialogAccepted !== true) return;
    this.trustFolder(toId, dir);
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

  /**
   * A token good for the next call, renewing it through the CLI when it is near the end of its
   * life. The CLI owns refresh-token rotation and takes a lock across it, so this asks rather than
   * doing it here: `claude doctor` renews an expired token and leaves a healthy one exactly as it
   * was, which is the whole of what is wanted and costs no tokens and no conversation.
   *
   * `auth status` was what this used to run, and it only ever reported what was on disk — so the
   * renewal never happened and a subscription nothing was running on simply died at its expiry and
   * sat there saying "token expired" until somebody logged in again.
   */
  private async freshToken(r: SubRow): Promise<string | null> {
    const creds = this.readCredentials(r.config_dir);
    if (!creds) return null;
    const expiresIn = creds.expiresAt ? creds.expiresAt - Date.now() : Infinity;
    // An expired token is worth nothing, so anything else is worth returning while we renew.
    const asIs = expiresIn > 0 ? creds.accessToken : null;
    if (expiresIn > TOKEN_MARGIN_MS) return creds.accessToken;
    if (Date.now() < (this.renewAfter.get(r.id) ?? 0)) return asIs;
    const claude = findClaude();
    if (!claude) return asIs;
    try {
      const env: NodeJS.ProcessEnv = withoutParentSession();
      if (r.kind === 'default') delete env.CLAUDE_CONFIG_DIR;
      else env.CLAUDE_CONFIG_DIR = r.config_dir;
      const cmd = claudeCommand(claude, ['doctor']);
      await execFileP(cmd.file, cmd.args, { cwd: SPAWN_CWD, env, timeout: 60_000, windowsHide: true });
    } catch (err) {
      log.debug('token renewal failed', err instanceof Error ? err.message : err);
    }
    const renewed = this.readCredentials(r.config_dir) ?? creds;
    const good = !renewed.expiresAt || renewed.expiresAt - Date.now() > TOKEN_MARGIN_MS;
    // A refresh token that no longer works fails the same way every minute; give it room.
    this.renewAfter.set(r.id, Date.now() + (good ? RENEW_EVERY_MS : RENEW_BACKOFF_MS));
    if (good && renewed.expiresAt !== creds.expiresAt) log.info('token renewed', { subscription: r.label, until: new Date(renewed.expiresAt!).toISOString() });
    return !renewed.expiresAt || renewed.expiresAt > Date.now() ? renewed.accessToken : null;
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

  /** A usable access token from any logged-in subscription, for account-independent lookups. */
  async anyReadyToken(): Promise<string | null> {
    for (const r of this.rows()) {
      if (!bool(r.enabled) || r.status !== 'ready') continue;
      const token = await this.freshToken(r);
      if (token) return token;
    }
    return null;
  }

  async refreshIdentity(id: string): Promise<void> {
    if (!this.db.open) return;
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
        if (res.ok && this.db.open) {
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
    if (Date.now() < this.cooldownUntil) return;
    const pollSec = getSettings(this.db).usagePollSec;
    for (const r of this.rows()) {
      if (r.status === 'pending_login') continue;
      // Idle subscriptions are polled far less often: their numbers only move when used.
      const interval = (this.liveRunsFor(r.id) > 0 ? pollSec : Math.max(pollSec * 5, 1800)) * 1000;
      if (Date.now() - (this.lastPoll.get(r.id) ?? 0) < interval) continue;
      await this.poll(r.id, false);
      if (Date.now() < this.cooldownUntil) return; // a 429 during this pass: stop early
    }
  }

  /** Keep a floor between calls so several subscriptions never burst at once. */
  private async spaceOutRequest(): Promise<void> {
    const gap = 1500 - (Date.now() - this.lastRequestAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.lastRequestAt = Date.now();
  }

  private applyRateLimit(res: Response): number {
    this.consecutive429++;
    const header = res.headers.get('retry-after');
    const fromHeader = header ? (/^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : NaN;
    // Honour Retry-After when present; otherwise back off exponentially, capped at 30 minutes.
    const wait = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : Math.min(30 * 60_000, 60_000 * 2 ** (this.consecutive429 - 1));
    this.cooldownUntil = Date.now() + wait;
    log.warn('usage endpoint rate limited', { retryAfter: header, waitSec: Math.round(wait / 1000), strike: this.consecutive429 });
    return wait;
  }

  async poll(id: string, force: boolean): Promise<Subscription | null> {
    // A poll can still be in flight when the daemon shuts down.
    if (!this.db.open) return null;
    const r = this.row(id);
    if (!r || r.status === 'pending_login' || this.inFlight.has(id)) return this.get(id);
    if (!force && Date.now() - (this.lastPoll.get(id) ?? 0) < 20_000) return this.get(id);
    if (Date.now() < this.cooldownUntil) {
      // Even a manual refresh waits out a 429; hammering it only extends the cooldown.
      this.markStale(r, `Usage API rate limited; retrying ${new Date(this.cooldownUntil).toISOString().slice(11, 16)} UTC`, 'rate_limited', new Date(this.cooldownUntil).toISOString());
      this.bus.invalidate('state');
      return this.get(id);
    }
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
        this.markStale(r, 'Token expired and could not be renewed. Log in again on this subscription.', 'token', null);
        return this.get(id);
      }
      await this.spaceOutRequest();
      const res = await this.oauthGet(token, '/api/oauth/usage');
      if (res.status === 429) {
        const wait = this.applyRateLimit(res);
        const retryAt = new Date(Date.now() + wait).toISOString();
        this.markStale(r, `Usage API rate limited; retrying ${retryAt.slice(11, 16)} UTC`, 'rate_limited', retryAt);
        return this.get(id);
      }
      if (res.status === 401) {
        this.db.run("UPDATE subscriptions SET status = 'logged_out', last_error = 'Login expired (401). Re-login.' WHERE id = ?", id);
        return this.get(id);
      }
      if (!res.ok) {
        this.markStale(r, `Usage endpoint returned HTTP ${res.status}`, 'network', null);
        return this.get(id);
      }
      this.consecutive429 = 0;
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
        errorKind: null,
        retryAt: null,
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
      this.markStale(r, err instanceof Error ? err.message : String(err), 'network', null);
      return this.get(id);
    } finally {
      this.inFlight.delete(id);
      this.bus.invalidate('state');
    }
  }

  private markStale(r: SubRow, error: string, errorKind: NonNullable<Usage['errorKind']>, retryAt: string | null): void {
    let usage: Usage | null = null;
    try {
      usage = r.usage_json ? (JSON.parse(r.usage_json) as Usage) : null;
    } catch {
      usage = null;
    }
    const next: Usage = usage
      ? { ...usage, stale: true, error, errorKind, retryAt }
      : { fiveHour: null, sevenDay: null, scoped: [], fetchedAt: now(), source: 'oauth', stale: true, error, errorKind, retryAt };
    this.db.run('UPDATE subscriptions SET usage_json = ? WHERE id = ?', JSON.stringify(next), r.id);
  }
}
