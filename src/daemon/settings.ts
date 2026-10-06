import { DEFAULT_WIND_DOWN_MESSAGE } from '../shared/respawn.ts';
import { DEFAULT_QUICK_PROMPTS } from '../shared/prompts.ts';
import type { QuickPrompt, Settings } from '../shared/types.ts';
import type { Db } from './db.ts';

export const DEFAULT_SETTINGS: Settings = {
  autoUpdate: true,
  updateCheckHours: 6,
  restartAfterUpdate: true,
  defaultModel: null,
  defaultAutoCompact: true,
  defaultAutoCompactTokens: 700_000,
  defaultSkipPermissions: true,
  defaultDiffPanel: false,
  defaultYouShouldKnow: true,
  defaultPlaywright: true,
  hotSwap: true,
  autoSwap: true,
  autoRevive: true,
  // Waiting for the limit means the swap lands mid-turn, which is the one time it costs something.
  // Moving an idle session while there is still headroom left spends a little of a subscription to
  // buy the next turn room to run long; 85 leaves enough for a turn of an hour or so.
  proactiveSwap: true,
  swapThresholdPct: 85,
  continueMessage: 'continue',
  windDownMessage: DEFAULT_WIND_DOWN_MESSAGE,
  // Long enough that a session finishing on its own is not interrupted for nothing.
  windDownAfterMin: 10,
  quickPrompts: DEFAULT_QUICK_PROMPTS,
  continueOnResume: true,
  // The usage endpoint is shared across all subscriptions and rate-limits aggressively; five
  // accounts polling every two minutes was enough to draw 429s.
  usagePollSec: 300,
  conflictWindowMin: 60,
  claudeArgs: [],
  repoRoots: [],
  terminalWindow: 'current',
};

export function getSettings(db: Db): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const row of db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (row.key in out) {
      try {
        (out as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value);
      } catch {
        // ignore corrupt values, keep the default
      }
    }
  }
  return out;
}

/**
 * Quick prompts as the settings page sent them, kept only where they can be typed: a prompt with
 * no text would send an empty Enter, and one with no label could not be told apart in the list.
 */
export function cleanQuickPrompts(input: unknown[]): QuickPrompt[] {
  const out: QuickPrompt[] = [];
  const ids = new Set<string>();
  for (const p of input.slice(0, 50)) {
    if (!p || typeof p !== 'object') continue;
    const { id, label, text } = p as Record<string, unknown>;
    if (typeof text !== 'string' || !text.trim()) continue;
    const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : text.trim().slice(0, 40);
    let key = typeof id === 'string' && id.trim() ? id.trim().slice(0, 40) : `p${out.length + 1}`;
    while (ids.has(key)) key = `${key}-${out.length + 1}`;
    ids.add(key);
    out.push({ id: key, label: name, text: text.trim().slice(0, 8000) });
  }
  return out;
}

export function updateSettings(db: Db, patch: Partial<Settings>): Settings {
  const current = getSettings(db);
  const next: Settings = { ...current };
  const n = (v: unknown, min: number, max: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

  if (typeof patch.autoUpdate === 'boolean') next.autoUpdate = patch.autoUpdate;
  if (patch.updateCheckHours !== undefined) next.updateCheckHours = n(patch.updateCheckHours, 1, 24 * 7, current.updateCheckHours);
  if (typeof patch.restartAfterUpdate === 'boolean') next.restartAfterUpdate = patch.restartAfterUpdate;
  if (patch.defaultModel !== undefined) next.defaultModel = typeof patch.defaultModel === 'string' && patch.defaultModel ? patch.defaultModel : null;
  if (typeof patch.defaultAutoCompact === 'boolean') next.defaultAutoCompact = patch.defaultAutoCompact;
  if (typeof patch.defaultSkipPermissions === 'boolean') next.defaultSkipPermissions = patch.defaultSkipPermissions;
  if (typeof patch.defaultDiffPanel === 'boolean') next.defaultDiffPanel = patch.defaultDiffPanel;
  if (typeof patch.defaultYouShouldKnow === 'boolean') next.defaultYouShouldKnow = patch.defaultYouShouldKnow;
  if (typeof patch.defaultPlaywright === 'boolean') next.defaultPlaywright = patch.defaultPlaywright;
  if (typeof patch.hotSwap === 'boolean') next.hotSwap = patch.hotSwap;
  if (patch.defaultAutoCompactTokens !== undefined) {
    next.defaultAutoCompactTokens = n(patch.defaultAutoCompactTokens, 20_000, 990_000, current.defaultAutoCompactTokens);
  }
  if (patch.usagePollSec !== undefined) next.usagePollSec = n(patch.usagePollSec, 60, 3600, current.usagePollSec);
  if (typeof patch.autoSwap === 'boolean') next.autoSwap = patch.autoSwap;
  if (typeof patch.autoRevive === 'boolean') next.autoRevive = patch.autoRevive;
  if (typeof patch.proactiveSwap === 'boolean') next.proactiveSwap = patch.proactiveSwap;
  if (patch.swapThresholdPct !== undefined) next.swapThresholdPct = n(patch.swapThresholdPct, 50, 100, current.swapThresholdPct);
  if (typeof patch.continueMessage === 'string') next.continueMessage = patch.continueMessage.slice(0, 2000);
  // Emptied is put back to the default: an empty message would type only the send-now chord.
  if (typeof patch.windDownMessage === 'string') next.windDownMessage = patch.windDownMessage.trim().slice(0, 4000) || DEFAULT_WIND_DOWN_MESSAGE;
  if (patch.windDownAfterMin !== undefined) next.windDownAfterMin = n(patch.windDownAfterMin, 0, 24 * 60, current.windDownAfterMin);
  if (Array.isArray(patch.quickPrompts)) next.quickPrompts = cleanQuickPrompts(patch.quickPrompts);
  if (typeof patch.continueOnResume === 'boolean') next.continueOnResume = patch.continueOnResume;
  if (patch.conflictWindowMin !== undefined) next.conflictWindowMin = n(patch.conflictWindowMin, 5, 24 * 60, current.conflictWindowMin);
  if (Array.isArray(patch.claudeArgs)) next.claudeArgs = patch.claudeArgs.filter((a) => typeof a === 'string' && a.length > 0);
  if (Array.isArray(patch.repoRoots)) {
    next.repoRoots = patch.repoRoots
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim())
      .slice(0, 20);
  }

  if (patch.terminalWindow === 'current' || patch.terminalWindow === 'switchboard') next.terminalWindow = patch.terminalWindow;

  db.tx(() => {
    for (const [key, value] of Object.entries(next)) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    }
  });
  return next;
}
