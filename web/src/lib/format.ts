import type { Model, Subscription, Usage, UsageWindow } from '@shared/types.ts';

export type Level = 'ok' | 'warn' | 'crit';

export function usageLevel(pct: number | null | undefined): Level {
  if (pct == null) return 'ok';
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

export function pctText(w: UsageWindow | null | undefined): string {
  return w ? `${Math.round(w.pct)}%` : '—';
}

export function planLabel(sub: Subscription): string {
  const plan = sub.plan ? sub.plan.replace(/^claude_/, '').replace(/_/g, ' ') : null;
  if (!plan) return sub.kind === 'default' ? 'default' : '—';
  const weight = sub.weight > 1 ? ` ${sub.weight}×` : '';
  return plan.toLowerCase().startsWith('max') && !/\d/.test(plan) ? `${plan}${weight}` : plan;
}

export function subUsageShort(sub: Subscription): string {
  const u = sub.usage;
  if (!u) return 'no usage yet';
  return `5h ${pctText(u.fiveHour)} · 7d ${pctText(u.sevenDay)}`;
}

/** Subscriptions a session can be launched on / swapped to. */
export function usableSubs(subs: Subscription[]): Subscription[] {
  return subs.filter((s) => s.enabled && s.status === 'ready').sort((a, b) => a.priority - b.priority);
}

export function subStatusLabel(s: Subscription['status']): string {
  switch (s) {
    case 'pending_login':
      return 'waiting for login';
    case 'logged_out':
      return 'logged out';
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
  }
}

export function shortPath(p: string | null | undefined, keep = 2): string {
  if (!p) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= keep) return p;
  return '…/' + parts.slice(-keep).join('/');
}

export function basename(p: string | null | undefined): string {
  if (!p) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- models ----

/** 700000 → "700K", 1000000 → "1M", 1500000 → "1.5M" */
export function tokensShort(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** "1M context" — the size that matters when picking a model for a long session. */
export function contextLabel(m: Model): string {
  return `${tokensShort(m.maxInputTokens)} context`;
}

/**
 * Short display name for a model id. Falls back to a tidied id when the catalog is unavailable,
 * so a session still shows something meaningful.
 */
export function modelShort(id: string | null | undefined, models: Model[]): string | null {
  if (!id) return null;
  const known = models.find((m) => m.id === id);
  if (known) return known.displayName;
  return id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// ---- usage staleness ----

export interface UsageIssue {
  label: string;
  tone: 'warn' | 'crit';
  title: string;
}

const ISSUES: Record<NonNullable<Usage['errorKind']>, UsageIssue> = {
  rate_limited: {
    label: 'rate limited',
    tone: 'warn',
    title: 'The usage endpoint is rate-limiting Switchboard. Polling is paused until it lets us back in; the numbers below are the last ones we got.',
  },
  auth: {
    label: 'login expired',
    tone: 'crit',
    title: 'This subscription is no longer signed in. Use Re-login to sign in again before usage can be read.',
  },
  token: {
    label: 'token expired',
    tone: 'warn',
    title: 'The OAuth token for this profile expired. Switchboard refreshes it on the next successful poll.',
  },
  network: {
    label: 'unreachable',
    tone: 'warn',
    title: 'Could not reach the usage endpoint. Check this machine’s connection.',
  },
};

/** What to show instead of a generic "stale" badge, or null when the numbers are current. */
export function usageIssue(u: Usage | null | undefined): UsageIssue | null {
  if (!u) return null;
  if (u.errorKind) return ISSUES[u.errorKind];
  if (!u.stale) return null;
  return { label: 'stale', tone: 'warn', title: u.error ?? 'Usage could not be refreshed.' };
}

/** True while polling is paused by a rate limit, so manual refreshes would be refused too. */
export function isRateLimited(u: Usage | null | undefined, now: number): boolean {
  if (!u || u.errorKind !== 'rate_limited') return false;
  if (!u.retryAt) return true;
  const t = Date.parse(u.retryAt);
  return Number.isNaN(t) || t > now;
}
