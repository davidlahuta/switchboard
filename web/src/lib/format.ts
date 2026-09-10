import type { Subscription, UsageWindow } from '@shared/types.ts';

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
