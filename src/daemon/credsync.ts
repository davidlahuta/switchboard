import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('creds');

/** File name Claude Code keeps its OAuth credentials under, in its secure-storage directory. */
export const CREDENTIALS_FILE = '.credentials.json';

/** How far ahead of expiry the canonical token is renewed, so no session ever renews its own. */
export const RENEW_AHEAD_MS = 15 * 60_000;
/** How long after a renewal was tried it is tried again, if the login is still near its end. */
const RENEW_RETRY_MS = 2 * 60_000;

/*
 * Private credentials per session, and the one thing that makes them safe: every copy of an
 * account's login is kept on the newest token.
 *
 * Claude Code reads its login from `<secure storage dir>/.credentials.json`, which is its config
 * directory unless CLAUDE_SECURESTORAGE_CONFIG_DIR says otherwise, and it re-reads that file as soon
 * as its mtime changes, before each request. So a session launched with a directory of its own can be
 * moved to another account without being restarted: write the other account's login into its file,
 * and its next request goes out as that account. Verified against a live process before this was
 * built: four turns, four files, each turn on the token that was in the file at the time.
 *
 * The cost is copies. A login is a pair of tokens, and renewing it replaces both — so the moment one
 * copy renews, every other copy of that account holds a refresh token that may no longer be honoured.
 * Two things keep that from mattering:
 *
 * - Switchboard renews centrally. The canonical file (the subscription profile's own) is renewed
 *   RENEW_AHEAD_MS before expiry, and the result is copied into every session's file within a tick.
 *   Claude Code only renews in the last five minutes, so in the normal course no session ever does.
 * - When a session does renew — Switchboard was down, a tick was missed — its new login is carried
 *   to the canonical file and every other copy. But only once the API has said which account the new
 *   token belongs to: a session renewing in the instant it was being moved could write one account's
 *   tokens into a file that is now meant for another, and propagating that would log a whole
 *   subscription in as somebody else. A token is filed under the subscription its account belongs to,
 *   whatever file it turned up in.
 */

export interface OauthLogin {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface CredsHolder {
  /** A running session's private copy: which run, and which subscription it holds the login of. */
  runId: string;
  subscriptionId: string;
}

export interface CredsDeps {
  /** Sessions that have a private copy now. */
  holders: () => CredsHolder[];
  /** The subscription profile's own credentials file. */
  canonicalFile: (subscriptionId: string) => string | null;
  /** Which subscription an account (by email) is, or null when none is. */
  subscriptionOfAccount: (email: string) => string | null;
  /** The account a token belongs to, asked of the API. */
  accountOf: (accessToken: string) => Promise<string | null>;
  /** Renew a subscription's canonical login (through the CLI). */
  renew: (subscriptionId: string) => Promise<void>;
}

export function parseLogin(text: string | null): OauthLogin | null {
  if (!text) return null;
  try {
    const o = (JSON.parse(text) as { claudeAiOauth?: OauthLogin }).claudeAiOauth;
    return o && typeof o.accessToken === 'string' && o.accessToken ? o : null;
  } catch {
    return null;
  }
}

/** A short, stable name for a token in logs: never the token itself. */
export const tokenId = (token: string): string => crypto.createHash('sha256').update(token).digest('hex').slice(0, 10);

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Replace a credentials file whole. Written beside it and renamed over it, so Claude Code never
 * reads half a file; retried briefly, because on Windows a rename can lose a race with a reader.
 */
export function writeCredentials(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 5) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) {
        // brief spin: this runs once per renewal, never in a loop that matters
      }
    }
  }
}

export class CredentialSync {
  private readonly root: string;
  private readonly deps: CredsDeps;
  /** What Switchboard last wrote into each run's file, so a change it did not make stands out. */
  private readonly written = new Map<string, string>();
  private readonly renewing = new Set<string>();
  /** When each subscription's renewal was last tried: a failed one is not retried every tick. */
  private readonly renewTried = new Map<string, number>();
  private ticking = false;

  constructor(deps: CredsDeps, root = path.join(RUNTIME_DIR, 'creds')) {
    this.deps = deps;
    this.root = root;
  }

  /** The directory a run's claude is given as CLAUDE_SECURESTORAGE_CONFIG_DIR. */
  dirFor(runId: string): string {
    return path.join(this.root, runId);
  }

  private fileFor(runId: string): string {
    return path.join(this.dirFor(runId), CREDENTIALS_FILE);
  }

  /**
   * Give a run its own copy of a subscription's login: before a spawn, and for a hot swap. Returns
   * the directory, or null when the subscription has no login to copy — the caller then leaves the
   * session on its profile's own file, as sessions always were.
   */
  assign(runId: string, subscriptionId: string): string | null {
    const canonical = this.deps.canonicalFile(subscriptionId);
    const text = canonical ? readText(canonical) : null;
    const login = parseLogin(text);
    if (!text || !login) return null;
    writeCredentials(this.fileFor(runId), text);
    this.written.set(runId, login.accessToken);
    log.info('gave a session the login of a subscription', { run: runId, subscription: subscriptionId, token: tokenId(login.accessToken) });
    return this.dirFor(runId);
  }

  /** Forget a run's copy once nothing is running on it. */
  release(runId: string): void {
    this.written.delete(runId);
    fs.rmSync(this.dirFor(runId), { recursive: true, force: true });
  }

  /** The token a run's copy holds now, for tests and diagnostics. */
  tokenOf(runId: string): string | null {
    return parseLogin(readText(this.fileFor(runId)))?.accessToken ?? null;
  }

  /** One pass: carry renewals made by sessions home, carry the newest login out, renew ahead. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const holders = this.deps.holders();
      await this.collectRenewals(holders);
      const bySub = new Map<string, CredsHolder[]>();
      for (const h of holders) bySub.set(h.subscriptionId, [...(bySub.get(h.subscriptionId) ?? []), h]);
      for (const [sub, list] of bySub) this.distribute(sub, list);
      for (const sub of bySub.keys()) this.renewAhead(sub);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A copy whose token is not the one Switchboard wrote was renewed by its session. Its login is
   * filed under the subscription its account belongs to — asked of the API, never assumed from the
   * file it was found in — when it is newer than what that subscription has.
   */
  private async collectRenewals(holders: CredsHolder[]): Promise<void> {
    for (const h of holders) {
      const text = readText(this.fileFor(h.runId));
      const login = parseLogin(text);
      if (!text || !login) continue;
      const mine = this.written.get(h.runId);
      if (mine === login.accessToken) continue;
      if (mine === undefined) {
        /*
         * Switchboard restarted since it wrote this. A copy no newer than its subscription's login is
         * the baseline, and distribute brings it up to date; a newer one is a renewal made while
         * Switchboard was down, and is confirmed and carried home like any other.
         */
        const current = parseLogin(readText(this.deps.canonicalFile(h.subscriptionId) ?? ''));
        if ((login.expiresAt ?? 0) <= (current?.expiresAt ?? 0)) {
          this.written.set(h.runId, login.accessToken);
          continue;
        }
      }
      const account = await this.deps.accountOf(login.accessToken).catch(() => null);
      const owner = account ? this.deps.subscriptionOfAccount(account) : null;
      if (!owner) {
        log.warn('a session renewed its login, but whose it is could not be confirmed; leaving it where it is', { run: h.runId, token: tokenId(login.accessToken) });
        continue;
      }
      this.written.set(h.runId, login.accessToken);
      const canonical = this.deps.canonicalFile(owner);
      const current = parseLogin(canonical ? readText(canonical) : null);
      if (canonical && (current?.expiresAt ?? 0) < (login.expiresAt ?? 0)) {
        writeCredentials(canonical, text);
        log.info('carried a login a session renewed back to its subscription', { run: h.runId, subscription: owner, token: tokenId(login.accessToken) });
      }
      if (owner !== h.subscriptionId) {
        // Renewed as one account while being moved to another: the file goes back to what it is for.
        log.warn('a session renewed the login it was being moved away from; filed it under its own subscription', { run: h.runId, renewedFor: owner, holds: h.subscriptionId });
        this.assign(h.runId, h.subscriptionId);
      }
    }
  }

  /** Every copy of a subscription's login on the newest one. */
  private distribute(sub: string, list: CredsHolder[]): void {
    const canonical = this.deps.canonicalFile(sub);
    const text = canonical ? readText(canonical) : null;
    const newest = parseLogin(text);
    if (!text || !newest) return;
    for (const h of list) {
      const copy = parseLogin(readText(this.fileFor(h.runId)));
      if (copy?.accessToken === newest.accessToken) continue;
      // Never backwards: a copy newer than the canonical file is a renewal collectRenewals has yet to confirm.
      if (copy && (copy.expiresAt ?? 0) > (newest.expiresAt ?? 0)) continue;
      writeCredentials(this.fileFor(h.runId), text);
      this.written.set(h.runId, newest.accessToken);
      log.info('brought a session up to its subscription\'s newest login', { run: h.runId, subscription: sub, token: tokenId(newest.accessToken) });
    }
  }

  private renewAhead(sub: string): void {
    const canonical = this.deps.canonicalFile(sub);
    const login = parseLogin(canonical ? readText(canonical) : null);
    if (!login?.expiresAt || login.expiresAt - Date.now() > RENEW_AHEAD_MS || this.renewing.has(sub)) return;
    if (Date.now() - (this.renewTried.get(sub) ?? 0) < RENEW_RETRY_MS) return;
    this.renewTried.set(sub, Date.now());
    this.renewing.add(sub);
    log.info('renewing a subscription\'s login ahead of its sessions', { subscription: sub, expiresInMin: Math.round((login.expiresAt - Date.now()) / 60_000) });
    void this.deps
      .renew(sub)
      .catch((err) => log.warn('could not renew a subscription\'s login', { subscription: sub, error: err instanceof Error ? err.message : err }))
      .finally(() => this.renewing.delete(sub));
  }
}
