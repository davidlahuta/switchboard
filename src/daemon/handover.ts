import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { DB_PATH, HOME_CLAUDE_DIR, IS_WINDOWS, PORT, PROFILES_DIR, RUNTIME_DIR, VERSION, ensureDirs } from '../config.ts';
import { LOCAL_DESK } from '../shared/desk.ts';
import { CREDENTIALS_FILE, writeCredentials } from './credsync.ts';
import { Db } from './db.ts';
import { protect, unprotect } from './secret.ts';
import { uninstallService } from './service.ts';

const run = promisify(execFile);

/*
 * Moving the hub to another machine.
 *
 * The hub is a database, the subscriptions' logins, and the hub's copies of each live session's
 * login. `hub export` packs those into one file on the old hub; `hub import` unpacks it on the new
 * one and turns the old hub into a satellite of it: its sessions, agents and repositories become
 * that desk's, and a claim code (good for a week) lets the old machine join as that desk with the
 * ordinary `desk join`. Its sessions never stop: their terminals reconnect to 127.0.0.1:4477 as they
 * do through any daemon restart, and the desk agent listening there relays them to the new hub.
 *
 * The export holds every login and secret in the clear. It is written readable only by its owner,
 * and belongs on the new machine for as long as the import takes and nowhere after.
 *
 * `--dry-run` exports with no logins, secrets, paired devices or push subscriptions, while the
 * daemon keeps running, for trying the import somewhere first. A hub imported from one does not
 * revive or update anything.
 */

export const BUNDLE_FORMAT = 'switchboard-hub/1';
/** How long the old hub has to join the new one as a desk. */
const CLAIM_TTL_MS = 7 * 24 * 3600_000;

interface Bundle {
  format: string;
  createdAt: string;
  version: string;
  dryRun: boolean;
  from: { hostname: string; platform: string; user: string };
  db: string;
  /** subscription id → file name → base64 */
  profiles: Record<string, Record<string, string>>;
  /** run id → the hub's copy of its login */
  logins: Record<string, string>;
  /** the login of the default subscription, which is the old hub user's own ~/.claude */
  defaultLogin?: string | null;
}

const now = (): string => new Date().toISOString();
const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** Whether something answers on the daemon's port here. */
export async function daemonAnswers(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/** Files at the top of a profile worth carrying: settings and logins, never the shared folders. */
function profileFiles(dir: string, withLogin: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.includes('.tmp') || name === 'history.jsonl' || name.endsWith('.log')) continue;
    if (name === CREDENTIALS_FILE && !withLogin) continue;
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
    out[name] = fs.readFileSync(file).toString('base64');
  }
  return out;
}

function readOr(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function tryExec(db: DatabaseSync, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // a table this version does not have
  }
}

/**
 * Stop this machine's daemon for good, leaving every session running: its automatic start is
 * removed and the processes are ended by id. On Windows that is the supervisor loop first (it would
 * start the daemon again), then the daemon; the sessions' terminals are processes of their own.
 */
export async function stopHub(): Promise<string[]> {
  const said: string[] = [];
  if (IS_WINDOWS) {
    const script = [
      "$all = Get-CimInstance Win32_Process -Filter \"Name='wscript.exe' OR Name='cscript.exe' OR Name='cmd.exe' OR Name='node.exe'\"",
      "$sup = $all | Where-Object { $_.CommandLine -like '*switchboard-daemon.vbs*' -or $_.CommandLine -like '*switchboard-daemon.cmd*' }",
      "$dmn = $all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'cli\\.ts\"?\\s+daemon\\s*$' }",
      "foreach ($p in @($sup) + @($dmn)) { if ($p) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; \"$($p.ProcessId) $($p.Name)\" } }",
    ].join('; ');
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60_000 });
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) said.push(`stopped ${line}`);
  }
  await uninstallService('daemon').catch(() => undefined);
  said.push('removed the daemon\'s automatic start');
  for (let i = 0; i < 20 && (await daemonAnswers()); i++) await new Promise((r) => setTimeout(r, 500));
  if (await daemonAnswers()) said.push(`! something still answers on port ${PORT}; stop it before exporting`);
  return said;
}

export async function exportHub(out: string, opts: { dryRun: boolean }): Promise<{ file: string; runs: number; subscriptions: number; logins: number; secrets: number }> {
  if (!opts.dryRun && (await daemonAnswers())) {
    throw new Error('The daemon is still running, and would go on changing what is exported. Stop it first: node src/cli.ts hub stop (sessions keep running).');
  }
  if (!fs.existsSync(DB_PATH)) throw new Error(`No hub here: ${DB_PATH} does not exist.`);
  const tmp = path.join(os.tmpdir(), `switchboard-export-${process.pid}-${Date.now()}.db`);
  const src = new DatabaseSync(DB_PATH);
  try {
    src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  let runs = 0;
  let secrets = 0;
  const logins: Record<string, string> = {};
  const subscriptions: string[] = [];
  let hasDefault = false;
  const db = new DatabaseSync(tmp);
  try {
    if (opts.dryRun) {
      tryExec(db, 'UPDATE cred_profiles SET secret = NULL, sealed = 0');
      tryExec(db, 'DELETE FROM push_subscriptions');
      tryExec(db, 'DELETE FROM devices');
      tryExec(db, 'UPDATE desks SET token_hash = NULL');
    } else {
      // Sealed to this Windows user on this machine, so opened here and sealed again on the new hub.
      for (const r of db.prepare('SELECT id, label, secret, sealed FROM cred_profiles WHERE secret IS NOT NULL').all() as Array<{ id: string; label: string; secret: string; sealed: number }>) {
        const plain = r.sealed ? await unprotect(r.secret) : r.secret;
        if (plain === null) throw new Error(`The secret of the credential "${r.label}" could not be opened here.`);
        db.prepare('UPDATE cred_profiles SET secret = ?, sealed = 0 WHERE id = ?').run(plain, r.id);
        secrets++;
      }
    }
    const live = db.prepare("SELECT id, creds_sub FROM runs WHERE status <> 'exited'").all() as Array<{ id: string; creds_sub: string | null }>;
    runs = live.length;
    if (!opts.dryRun) {
      for (const r of live) {
        if (!r.creds_sub) continue;
        const file = path.join(RUNTIME_DIR, 'creds', r.id, CREDENTIALS_FILE);
        if (fs.existsSync(file)) logins[r.id] = fs.readFileSync(file, 'utf8');
      }
    }
    for (const s of db.prepare('SELECT id, kind FROM subscriptions').all() as Array<{ id: string; kind: string }>) {
      if (s.kind === 'default') hasDefault = true;
      else subscriptions.push(s.id);
    }
  } finally {
    db.close();
  }
  const profiles: Record<string, Record<string, string>> = {};
  for (const id of subscriptions) profiles[id] = profileFiles(path.join(PROFILES_DIR, id), !opts.dryRun);
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    createdAt: now(),
    version: VERSION,
    dryRun: opts.dryRun,
    from: { hostname: os.hostname(), platform: process.platform, user: os.userInfo().username },
    db: fs.readFileSync(tmp).toString('base64'),
    profiles,
    logins,
    defaultLogin: hasDefault && !opts.dryRun ? (readOr(path.join(HOME_CLAUDE_DIR, CREDENTIALS_FILE)) ?? null) : null,
  };
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(bundle)), { mode: 0o600 });
  return { file: path.resolve(out), runs, subscriptions: subscriptions.length + (hasDefault ? 1 : 0), logins: Object.keys(logins).length, secrets };
}

export interface ImportResult {
  deskId: string;
  deskName: string;
  code: string;
  runs: number;
  subscriptions: number;
  dryRun: boolean;
  backup: string | null;
  notes: string[];
}

/** The pairing-code alphabet, so a claim reads like any other code. */
function claimCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...crypto.randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join('');
}

export async function importHub(file: string, opts: { force?: boolean; name?: string } = {}): Promise<ImportResult> {
  if (await daemonAnswers()) throw new Error(`Something answers on port ${PORT} here. Stop the daemon before importing a hub into it.`);
  const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as Bundle;
  if (bundle.format !== BUNDLE_FORMAT) throw new Error(`${file} is not a Switchboard hub export.`);
  ensureDirs();
  let backup: string | null = null;
  if (fs.existsSync(DB_PATH)) {
    if (!opts.force) throw new Error(`${DB_PATH} already exists. Pass --force to keep it aside (as a .bak file) and import over it.`);
    backup = `${DB_PATH}.bak-${Date.now()}`;
    fs.renameSync(DB_PATH, backup);
    for (const ext of ['-wal', '-shm']) fs.rmSync(DB_PATH + ext, { force: true });
  }
  fs.writeFileSync(DB_PATH, Buffer.from(bundle.db, 'base64'), { mode: 0o600 });
  const db = new Db(DB_PATH);
  const deskId = crypto.randomBytes(4).toString('hex');
  const deskName = (opts.name?.trim() || bundle.from.hostname).slice(0, 60);
  const code = claimCode();
  let runs = 0;
  let subscriptions = 0;
  try {
    db.raw.exec('BEGIN');
    const old = db.get<{ max_sessions: number | null; clone_root: string | null; repo_roots: string | null }>('SELECT max_sessions, clone_root, repo_roots FROM desks WHERE id = ?', LOCAL_DESK);
    const parse = (v: string | null | undefined): string[] => {
      try {
        const x = v ? (JSON.parse(v) as unknown) : [];
        return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
      } catch {
        return [];
      }
    };
    const settingRoots = parse(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'repoRoots'")?.value);
    const roots = [...new Set([...parse(old?.repo_roots), ...settingRoots])];
    // The old hub, as the satellite it is about to become: what was the hub's own is now its.
    db.run(
      'INSERT INTO desks (id, name, hostname, token_hash, max_sessions, enabled, clone_root, repo_roots, info_json, created_at) VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)',
      deskId,
      deskName,
      bundle.from.hostname,
      old?.max_sessions ?? null,
      old?.clone_root ?? null,
      roots.length ? JSON.stringify(roots) : null,
      JSON.stringify({ platform: bundle.from.platform, user: bundle.from.user }),
      now(),
    );
    const mine = "desk_id IS NULL OR desk_id = 'local'";
    runs = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE status <> 'exited' AND (${mine})`)?.n ?? 0;
    for (const table of ['runs', 'agents', 'repos']) db.run(`UPDATE ${table} SET desk_id = ? WHERE ${mine}`, deskId);
    db.run('UPDATE desk_repos SET desk_id = ? WHERE desk_id = ?', deskId, LOCAL_DESK);
    for (const p of db.all<{ remote_key: string; allowed_desks: string | null }>('SELECT remote_key, allowed_desks FROM repo_policy WHERE allowed_desks IS NOT NULL')) {
      const ids = parse(p.allowed_desks).map((id) => (id === LOCAL_DESK ? deskId : id));
      db.run('UPDATE repo_policy SET allowed_desks = ? WHERE remote_key = ?', JSON.stringify(ids), p.remote_key);
    }
    // This machine is the hub now, starting from nothing of its own.
    db.run('UPDATE desks SET name = ?, hostname = ?, max_sessions = NULL, clone_root = NULL, repo_roots = NULL, info_json = NULL, last_seen = NULL WHERE id = ?', os.hostname(), os.hostname(), LOCAL_DESK);
    db.run("INSERT INTO settings (key, value) VALUES ('repoRoots', '[]') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    // A profile is a folder of this machine's.
    const base = bundle.from.platform === 'win32' ? path.win32.basename : path.posix.basename;
    for (const s of db.all<{ id: string; kind: string; config_dir: string }>('SELECT id, kind, config_dir FROM subscriptions')) {
      // The default subscription is whoever is signed in to this user's own ~/.claude; in a trial, a
      // folder of the trial's, so nothing it does can touch a login this machine really uses.
      const dir = s.kind === 'default' && !bundle.dryRun ? HOME_CLAUDE_DIR : path.join(PROFILES_DIR, s.kind === 'default' ? 'default' : base(s.config_dir) || s.id);
      db.run('UPDATE subscriptions SET config_dir = ? WHERE id = ?', dir, s.id);
      subscriptions++;
    }
    db.run('INSERT INTO desk_claims (code_hash, desk_id, expires_at) VALUES (?, ?, ?)', sha256(code), deskId, new Date(Date.now() + CLAIM_TTL_MS).toISOString());
    if (bundle.dryRun) {
      // A trial: nothing here is to be brought back, restarted or updated on anybody's behalf.
      for (const [key, value] of [['autoRevive', 'false'], ['autoUpdate', 'false'], ['restartAfterUpdate', 'false']]) {
        db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
      }
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    db.close();
    throw err;
  }
  // Sealed again where there is something to seal with.
  for (const r of db.all<{ id: string; secret: string }>('SELECT id, secret FROM cred_profiles WHERE secret IS NOT NULL AND sealed = 0')) {
    const box = await protect(r.secret);
    if (box) db.run('UPDATE cred_profiles SET secret = ?, sealed = 1 WHERE id = ?', box, r.id);
  }
  db.close();
  for (const [sub, files] of Object.entries(bundle.profiles)) {
    if (!/^[A-Za-z0-9._-]+$/.test(sub)) continue;
    const dir = path.join(PROFILES_DIR, sub);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      if (name.includes('/') || name.includes('\\') || name.startsWith('..')) continue;
      const text = Buffer.from(data, 'base64');
      if (name === CREDENTIALS_FILE) writeCredentials(path.join(dir, name), text.toString('utf8'));
      else fs.writeFileSync(path.join(dir, name), text);
    }
  }
  for (const [runId, content] of Object.entries(bundle.logins)) {
    if (!/^[a-f0-9]+$/.test(runId)) continue;
    writeCredentials(path.join(RUNTIME_DIR, 'creds', runId, CREDENTIALS_FILE), content);
  }
  const notes: string[] = [];
  if (bundle.defaultLogin) {
    const home = path.join(HOME_CLAUDE_DIR, CREDENTIALS_FILE);
    const here = readOr(home);
    if (here === null) {
      writeCredentials(home, bundle.defaultLogin);
      notes.push(`The default subscription's login is now ${home}.`);
    } else if (here !== bundle.defaultLogin) {
      const aside = `${home}.from-${bundle.from.hostname}`;
      writeCredentials(aside, bundle.defaultLogin);
      notes.push(`${home} already holds a login, so it was kept, and the old hub's default login was put at ${aside}. Use one of them for the default subscription; whichever account it is, sign out of it on the old hub.`);
    }
  }
  if (!IS_WINDOWS) fs.chmodSync(DB_PATH, 0o600);
  return { deskId, deskName, code, runs, subscriptions, dryRun: bundle.dryRun, backup, notes };
}
