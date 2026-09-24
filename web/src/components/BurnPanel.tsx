import type { BurnForecast, BurnPool, Subscription } from '@shared/types.ts';
import { Section } from './ui.tsx';
import { formatDuration } from '../lib/time.ts';

/**
 * When the desk has to stop.
 *
 * The per-subscription cards answer "where should the next session go". This answers the question
 * that actually decides an afternoon: at what the desk is spending right now, does it run out of room
 * before the windows under it turn over? Often the answer is no — the windows hand capacity back
 * faster than eight sessions can spend it — and "never" is worth saying out loud, because the
 * alternative is reading a dozen percentages and guessing.
 *
 * Every number here is the daemon's, in capacity units (see shared/capacity.ts): the 5-hour windows
 * and the weeks are simulated together, the way they limit a session, from the same figures the
 * swaps are decided on.
 */
export function BurnPanel({ burn, subs, now }: { burn: BurnForecast; subs: Subscription[]; now: number }) {
  const verdict = verdictOf(burn, now);
  const ceilings = scopedCeilings(subs);
  return (
    <Section title="Usage burn rate" actions={<span className="dim small">{measuredFrom(burn)}</span>}>
      <p className={`burn-verdict ${verdict.tone}`}>{verdict.text}</p>
      <div className="burn-grid">
        <BurnRow
          label="Usable now"
          hint="Each subscription's 5-hour window, capped by what is left of its week: what sessions can spend before a limit stops them. This is what the swaps are decided on."
          pool={burn.now}
          eta={burn.stopsAt}
          rate={burn.rate}
          now={now}
        />
        <BurnRow
          label="This week"
          hint="What is left of every subscription's week. It reaches further out, so it bites on long runs rather than long afternoons."
          pool={burn.week}
          eta={burn.week.exhaustedAt}
          rate={burn.rate}
          now={now}
        />
      </div>
      <p className="burn-scoped">
        A week holds about <strong>{burn.weekWindows.toFixed(1)}</strong> five-hour windows
        {burn.weekWindowsMeasured ? ', measured from how the two climb together in this desk’s own history' : ' — assumed until the desk has history to measure it from'}
        . So a point of a week is worth about {burn.weekWindows.toFixed(1)} points of a 5-hour window, and both are compared in
        capacity units: 1 unit is a Pro plan’s 5-hour window, a Max 20× window is 20.
      </p>
      {ceilings.length > 0 && (
        <p className="burn-scoped">
          Under the week, not part of it:{' '}
          {ceilings.map((c, i) => (
            <span key={c.label}>
              {i > 0 && ', '}
              <strong>{c.label}</strong> {Math.round(c.leftPct)}% left
            </span>
          ))}
          . Work on those models counts against the week as well; everything else counts only against the week, so a spent
          ceiling here stops the sessions running that model and no others.
        </p>
      )}
    </Section>
  );
}

/**
 * The per-model weekly ceilings, pooled the same way the week is.
 *
 * Shown apart from it on purpose. They are a second limit under the week rather than a slice of it,
 * and reading the two as one number is how a desk with most of its week in hand looks like a desk
 * that has run out.
 */
function scopedCeilings(subs: Subscription[]): Array<{ label: string; leftPct: number }> {
  const by = new Map<string, { capacity: number; left: number }>();
  for (const s of subs) {
    if (!s.enabled || s.status !== 'ready' || s.accountMismatch) continue;
    for (const w of s.usage?.scoped ?? []) {
      const e = by.get(w.label) ?? { capacity: 0, left: 0 };
      e.capacity += s.weekSize;
      e.left += (s.weekSize * (100 - w.pct)) / 100;
      by.set(w.label, e);
    }
  }
  return [...by]
    .map(([label, e]) => ({ label, leftPct: e.capacity > 0 ? (e.left / e.capacity) * 100 : 0 }))
    .sort((a, b) => a.leftPct - b.leftPct);
}

function at(iso: string, now: number): string {
  const when = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = Date.parse(iso) - now > 20 * 3600_000 ? `${new Date(iso).toLocaleDateString([], { weekday: 'long' })} ` : '';
  return `${day}at ${when}`;
}

function verdictOf(burn: BurnForecast, now: number): { text: string; tone: string } {
  if (!burn.now.capacity) return { text: 'No subscriptions are ready, so there is nothing to spend.', tone: 'burn-quiet' };
  if (!burn.stopsAt) {
    return burn.rate > 0
      ? { text: 'Never at this rate — the 5-hour windows and the weeks hand room back faster than the desk spends it.', tone: 'burn-ok' }
      : { text: 'Nothing is being spent right now.', tone: 'burn-quiet' };
  }
  const inMs = Date.parse(burn.stopsAt) - now;
  const what =
    burn.stopsOn === 'sevenDay'
      ? 'every subscription has used up its week'
      : 'every subscription with week left has used up its 5-hour window';
  const back = burn.resumesAt ? ` Room comes back ${at(burn.resumesAt, now)}.` : '';
  return {
    text: `At this rate the desk stops ${at(burn.stopsAt, now)} — in ${formatDuration(Math.max(0, inMs))} — when ${what}.${back}`,
    tone: inMs < 2 * 3600_000 ? 'burn-crit' : 'burn-warn',
  };
}

function measuredFrom(burn: BurnForecast): string {
  if (!burn.samples || burn.spanHours <= 0) return 'not enough history yet';
  return `measured over the last ${formatDuration(burn.spanHours * 3600_000)}`;
}

function BurnRow({ label, hint, pool, eta, rate, now }: { label: string; hint: string; pool: BurnPool; eta: string | null; rate: number; now: number }) {
  const leftPct = pool.capacity > 0 ? Math.max(0, Math.min(100, (pool.remaining / pool.capacity) * 100)) : 0;
  const level = leftPct <= 10 ? 'crit' : leftPct <= 30 ? 'warn' : 'ok';
  const runsOut = eta ? Date.parse(eta) - now : null;
  const resetIn = pool.nextResetAt ? Date.parse(pool.nextResetAt) - now : null;
  return (
    <div className="burn-row" title={hint}>
      <div className="burn-row-head">
        <span className="tile-label">{label}</span>
        <span className={`burn-eta lvl-${runsOut === null ? 'ok' : level}`}>
          {runsOut === null ? 'never' : `stops in ${formatDuration(Math.max(0, runsOut))}`}
        </span>
      </div>
      <div className="usage-track" role="meter" aria-label={`${label} left`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(leftPct)}>
        <div className={`usage-fill fill-${level}`} style={{ width: `${leftPct}%` }} />
      </div>
      <span className="tile-sub">
        {Math.round(leftPct)}% left ({units(pool.remaining)} of {units(pool.capacity)} units)
        {rate > 0 ? ` · spending ${rateText(rate, pool.capacity)}` : ' · nothing being spent'}
        {resetIn !== null && ` · first reset in ${formatDuration(Math.max(0, resetIn))}`}
      </span>
    </div>
  );
}

function units(n: number): string {
  return n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');
}

/**
 * The rate as a share of the pool, per hour. Capacity units are the honest unit but mean nothing on
 * their own; against the pool they read as "an eighth of everything, every hour".
 */
function rateText(rate: number, capacity: number): string {
  const perHour = capacity > 0 ? (rate / capacity) * 100 : 0;
  return `${perHour < 1 ? perHour.toFixed(1) : Math.round(perHour)}% of it an hour`;
}
