import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME_CLAUDE_DIR, HOME_CLAUDE_JSON, SPAWN_CWD, withoutParentSession } from '../config.ts';
import { logger } from '../log.ts';
import type { IntegrationStatus } from '../shared/types.ts';
import { claudeCommand, findClaude, hooksConfig, isSwitchboardHookUrl, mcpServerEntry, readJson, writeJson } from './claude.ts';

const log = logger('integration');
const run = promisify(execFile);
const SETTINGS = path.join(HOME_CLAUDE_DIR, 'settings.json');

type HookEntry = { matcher?: string; hooks?: Array<{ url?: unknown }> };
type SettingsFile = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

const isOurs = (e: HookEntry): boolean => (e.hooks ?? []).some((h) => isSwitchboardHookUrl(h.url));

/** Remove Switchboard's entries from a settings object's hooks block (in place). */
export function stripHooks(settings: SettingsFile): void {
  if (!settings.hooks) return;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const kept = (entries ?? []).filter((e) => !isOurs(e));
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

export function hooksInstalledIn(settingsFile: string): boolean {
  const s = readJson<SettingsFile>(settingsFile);
  return !!s?.hooks && Object.values(s.hooks).some((entries) => (entries ?? []).some(isOurs));
}

export function integrationStatus(): IntegrationStatus {
  const cfg = readJson<{ mcpServers?: Record<string, unknown> }>(HOME_CLAUDE_JSON);
  return { mcpInstalled: !!cfg?.mcpServers?.switchboard, hooksInstalled: hooksInstalledIn(SETTINGS) };
}

async function claudeCli(args: string[]): Promise<void> {
  const claude = findClaude();
  if (!claude) throw new Error('claude executable not found on PATH');
  const cmd = claudeCommand(claude, args);
  await run(cmd.file, cmd.args, { cwd: SPAWN_CWD, env: withoutParentSession(), timeout: 30_000, windowsHide: true });
}

/** Register the MCP shim at user scope and add Switchboard's HTTP hooks to ~/.claude/settings.json. */
export async function installIntegration(): Promise<IntegrationStatus> {
  try {
    await claudeCli(['mcp', 'remove', '--scope', 'user', 'switchboard']);
  } catch {
    // not registered yet
  }
  await claudeCli(['mcp', 'add-json', '--scope', 'user', 'switchboard', JSON.stringify(mcpServerEntry())]);
  const settings = readJson<SettingsFile>(SETTINGS) ?? {};
  stripHooks(settings);
  settings.hooks ??= {};
  for (const [event, entries] of Object.entries(hooksConfig())) {
    settings.hooks[event] = [...(settings.hooks[event] ?? []), ...(entries as HookEntry[])];
  }
  fs.mkdirSync(HOME_CLAUDE_DIR, { recursive: true });
  writeJson(SETTINGS, settings);
  log.info('integration installed');
  return integrationStatus();
}

export async function uninstallIntegration(): Promise<IntegrationStatus> {
  try {
    await claudeCli(['mcp', 'remove', '--scope', 'user', 'switchboard']);
  } catch (err) {
    log.warn('mcp remove failed', err instanceof Error ? err.message : err);
  }
  const settings = readJson<SettingsFile>(SETTINGS);
  if (settings) {
    stripHooks(settings);
    writeJson(SETTINGS, settings);
  }
  log.info('integration removed');
  return integrationStatus();
}
