import { SPAWN_CWD, withoutParentSession } from '../config.ts';
import { logger } from '../log.ts';
import { YOU_SHOULD_KNOW_PLUGIN } from '../shared/plugins.ts';
import { execFileOff } from '../spawnOff.ts';
import { claudeCommand, findClaude } from './claude.ts';

const log = logger('plugins');

/*
 * Plugins every session is started with.
 *
 * "You should know" is one of Claude Code's own: it ships inside the claude binary (marketplace
 * `builtin`), so there is nothing to download, and a session gets it by naming it in its settings'
 * enabledPlugins, which the per-run settings file does (see RunManager.buildSpec). What can be missing
 * is the plugin itself, in a claude older than the one that ships it. So it is checked here when the
 * daemon starts and whenever claude changes: asked for by name, installed if claude says it has to be,
 * and if it is still not there, sessions are not told to enable a plugin claude would only warn about.
 */

export interface PluginStatus {
  id: string;
  /** null while it has not been checked yet */
  available: boolean | null;
  detail: string | null;
}

const status: PluginStatus = { id: YOU_SHOULD_KNOW_PLUGIN, available: null, detail: null };

export function youShouldKnowStatus(): PluginStatus {
  return { ...status };
}

async function claude(args: string[]): Promise<{ ok: boolean; out: string }> {
  const bin = findClaude();
  if (!bin) return { ok: false, out: 'claude is not on PATH' };
  const cmd = claudeCommand(bin, args);
  try {
    const r = await execFileOff(cmd.file, cmd.args, { cwd: SPAWN_CWD, env: withoutParentSession(), timeout: 60_000, windowsHide: true });
    return { ok: true, out: r.stdout };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || (e.message ?? String(err)) };
  }
}

/** Make sure the plugin is there, installing it if claude needs it installed. */
export async function ensureYouShouldKnow(): Promise<PluginStatus> {
  const id = YOU_SHOULD_KNOW_PLUGIN;
  let details = await claude(['plugin', 'details', id]);
  if (!details.ok) {
    const installed = await claude(['plugin', 'install', id]);
    log.info('the You should know plugin was not found; asked claude to install it', { ok: installed.ok, said: installed.out.split('\n').pop() });
    details = await claude(['plugin', 'details', id]);
  }
  const was = status.available;
  status.available = details.ok;
  status.detail = details.ok ? null : details.out.split('\n').filter(Boolean).pop()?.slice(0, 300) ?? 'not available';
  if (!details.ok && was !== false) log.warn('the You should know plugin is not available in this claude; sessions start without it', { detail: status.detail });
  if (details.ok && was !== true) log.info('the You should know plugin is available; sessions enable it unless told not to');
  return youShouldKnowStatus();
}
