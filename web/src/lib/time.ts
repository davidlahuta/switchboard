import { useEffect, useState } from 'react';

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "12s", "3m", "1h 12m", "2d 4h" */
export function formatDuration(totalMs: number): string {
  const s = Math.max(0, Math.round(totalMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "just now", "3m ago", "2d ago" */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  const t = ms(iso);
  if (t === null) return '—';
  const diff = now - t;
  if (diff < 10_000) return 'just now';
  if (diff < 0) return 'just now';
  return `${formatDuration(diff)} ago`;
}

/** "resets in 1h 12m" / "resetting…" / "not started" */
export function resetsIn(iso: string | null | undefined, now = Date.now()): string {
  const t = ms(iso);
  if (t === null) return 'window not started';
  const diff = t - now;
  if (diff <= 0) return 'resetting…';
  return `resets in ${formatDuration(diff)}`;
}

/** "in 8m 12s" style countdown with seconds for short spans */
export function countdown(iso: string | null | undefined, now = Date.now()): string {
  const t = ms(iso);
  if (t === null) return '—';
  const s = Math.max(0, Math.round((t - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** "retry in 4m" / "retry in 45s" / "retrying…" — for paused polling after a rate limit. */
export function retryIn(iso: string | null | undefined, now = Date.now()): string {
  const t = ms(iso);
  if (t === null) return 'retry time unknown';
  const diff = t - now;
  if (diff <= 0) return 'retrying…';
  return `retry in ${formatDuration(diff)}`;
}

export function absTime(iso: string | null | undefined): string {
  const t = ms(iso);
  if (t === null) return '';
  return new Date(t).toLocaleString();
}

export function clockTime(iso: string | null | undefined): string {
  const t = ms(iso);
  if (t === null) return '';
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Re-render every `intervalMs` and return the current timestamp. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
