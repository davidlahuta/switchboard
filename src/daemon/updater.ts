import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME_CLAUDE_DIR, SPAWN_CWD, withoutParentSession } from '../config.ts';
import { logger } from '../log.ts';
import type { UpdateStatus } from '../shared/types.ts';
import type { Bus } from './bus.ts';
import { claudeCommand, findClaude, readJson } from './claude.ts';
import type { Db } from './db.ts';
import { now } from './db.ts';
import type { RunManager } from './runs.ts';
import { getSettings } from './settings.ts';

const log = logger('updater');
const run = promisify(execFile);

const TICK_MS = 5 * 60_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;

interface LastUpdateResult {
  timestamp?: string;
  outcome?: string;
  status?: string;
  version_from?: string;
  version_to?: string;
  error_code?: string | null;
}

/** "2.1.267 (Claude Code)" -> "2.1.267" */
function parseVersion(output: string): string | null {
  return output.trim().match(/\d+\.\d+\.\d+[^\s]*/)?.[0] ?? null;
}

/**
 * Keeps the claude executable current and, when the version moves, restarts hosted sessions so
 * they run the new build. Sessions are restarted by resuming their session GUID, so a restart is
 * invisible apart from a repaint.
 */
export class Updater {
  private readonly db: Db;
  private readonly bus: Bus;
  private readonly runs: RunManager;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private lastCheckAt: string | null = null;
  private lastError: string | null = null;
  private lastUpdate: { from: string; to: string; at: string } | null = null;
  currentVersion: string | null = null;

  constructor(db: Db, bus: Bus, runs: RunManager) {
    this.db = db;
    this.bus = bus;
    this.runs = runs;
  }

  start(): void {
    void this.readVersion().then((v) => {
      this.currentVersion = v;
      this.bus.invalidate('state');
    });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): UpdateStatus {
    return {
      currentVersion: this.currentVersion,
      lastCheckAt: this.lastCheckAt,
      lastUpdate: this.lastUpdate,
      checking: this.checking,
      lastError: this.lastError,
      pendingRestarts: this.runs.pendingRestartCount(),
    };
  }

  private async readVersion(): Promise<string | null> {
    const claude = findClaude();
    if (!claude) return null;
    try {
      const cmd = claudeCommand(claude, ['--version']);
      const { stdout } = await run(cmd.file, cmd.args, { cwd: SPAWN_CWD, env: withoutParentSession(), timeout: 30_000, windowsHide: true });
      return parseVersion(stdout);
    } catch (err) {
      log.warn('could not read claude version', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async tick(): Promise<void> {
    const s = getSettings(this.db);
    if (!s.autoUpdate || this.checking) return;
    const due = !this.lastCheckAt || Date.now() - Date.parse(this.lastCheckAt) >= s.updateCheckHours * 3600_000;
    if (due) await this.check(false);
  }

  /** Run `claude update`; on a version change, restart hosted sessions onto the new build. */
  async check(manual: boolean): Promise<UpdateStatus> {
    if (this.checking) return this.status();
    const claude = findClaude();
    if (!claude) {
      this.lastError = 'claude executable not found on PATH';
      return this.status();
    }
    this.checking = true;
    this.lastError = null;
    this.bus.invalidate('state');
    const before = (await this.readVersion()) ?? this.currentVersion;
    try {
      const cmd = claudeCommand(claude, ['update']);
      const { stdout, stderr } = await run(cmd.file, cmd.args, { cwd: SPAWN_CWD, env: withoutParentSession(), timeout: UPDATE_TIMEOUT_MS, windowsHide: true });
      log.debug('claude update output', (stdout || stderr).trim().slice(0, 400));
    } catch (err) {
      // A failed update is not fatal: report it and keep the current version.
      this.lastError = err instanceof Error ? err.message.split('\n')[0] : String(err);
      log.warn('claude update failed', this.lastError);
    }
    this.lastCheckAt = now();
    const after = (await this.readVersion()) ?? before;
    this.currentVersion = after;

    // Claude Code records a structured outcome; prefer it over comparing version strings.
    const result = readJson<LastUpdateResult>(path.join(HOME_CLAUDE_DIR, '.last-update-result.json'));
    if (result?.status && result.status !== 'success' && result.error_code) {
      this.lastError = `update ${result.status}: ${result.error_code}`;
    }
    const changed = !!before && !!after && before !== after;
    if (changed) {
      this.lastUpdate = { from: before, to: after, at: this.lastCheckAt };
      log.info('claude updated', { from: before, to: after });
      this.bus.toast('info', `Claude Code updated: ${before} → ${after}`);
      if (getSettings(this.db).restartAfterUpdate) {
        const n = this.runs.restartAll(`claude ${after}`);
        if (n > 0) this.bus.toast('info', `${n} session(s) will restart on ${after} once idle.`);
      }
    } else if (manual) {
      this.bus.toast('info', this.lastError ? `Update check failed: ${this.lastError}` : `Already on the latest version (${after ?? 'unknown'}).`);
    }
    this.checking = false;
    this.bus.invalidate('state');
    return this.status();
  }
}
