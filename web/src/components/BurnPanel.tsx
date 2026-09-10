import type { BurnForecast, BurnWindow } from '@shared/types.ts';
import { Section } from './ui.tsx';
import { formatDuration } from '../lib/time.ts';

/**
 * When the desk has to stop.
 *
 * The per-subscription cards answer "where should the next session go". This answers the question
 * that actually decides an afternoon: at what the desk is spending right now, does a ceiling arrive
 * before the window under it turns over? Often the answer is no — the windows hand capacity back
 * faster than eight sessions can spend it — and "never" is worth saying out loud, because the
 * alternative is reading four percentages and guessing.
 */
export function BurnPanel({ burn, now }: { burn: BurnForecast; now: number }) {
  const verdict = soonest(burn, now);
  return (
    <Section title="Usage burn rate" actions={<span className="dim small">{measuredFrom(burn)}</span>}>
      <p className={`burn-verdict ${verdict.tone}`}>{verdict.text}</p>
      <div className="burn-grid">
        <BurnRow label="5-hour window" hint="Rolling: each subscription's own window turns over five hours after it opened." w={burn.fiveHour} now={now} />
        <BurnRow label="7-day window" hint="The weekly ceiling. It reaches further out, so it bites on long runs rather than long afternoons." w={burn.sevenDay} now={now} />
      </div>
    </Section>
  );
}

/** Whichever ceiling arrives first is the one that stops the desk; either alone is enough. */
function soonest(burn: BurnForecast, now: number): { text: string; tone: string } {
  const both = [
    { name: '5-hour', at: burn.fiveHour.exhaustedAt, w: burn.fiveHour },
    { name: '7-day', at: burn.sevenDay.exhaustedAt, w: burn.sevenDay },
  ]
    .filter((x): x is { name: string; at: string; w: BurnWindow } => x.at !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (!burn.fiveHour.capacity) return { text: 'No subscriptions are ready, so there is nothing to spend.', tone: 'burn-quiet' };
  if (!both.length) {
    const spending = burn.fiveHour.rate > 0 || burn.sevenDay.rate > 0;
    return spending
      ? { text: 'Never at this rate — the windows turn over faster than the desk spends them.', tone: 'burn-ok' }
      : { text: 'Nothing is being spent right now.', tone: 'burn-quiet' };
  }
  const first = both[0];
  const inMs = Date.parse(first.at) - now;
  const when = new Date(first.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = Date.parse(first.at) - now > 20 * 3600_000 ? `${new Date(first.at).toLocaleDateString([], { weekday: 'long' })} ` : '';
  return {
    text: `At this rate the ${first.name} ceiling stops the desk ${day}at ${when} — in ${formatDuration(Math.max(0, inMs))}.`,
    tone: inMs < 2 * 3600_000 ? 'burn-crit' : 'burn-warn',
  };
}

function measuredFrom(burn: BurnForecast): string {
  const span = Math.max(burn.fiveHour.spanHours, burn.sevenDay.spanHours);
  const samples = Math.max(burn.fiveHour.samples, burn.sevenDay.samples);
  if (!samples || span <= 0) return 'not enough history yet';
  return `measured over the last ${formatDuration(span * 3600_000)}`;
}

function BurnRow({ label, hint, w, now }: { label: string; hint: string; w: BurnWindow; now: number }) {
  const leftPct = w.capacity > 0 ? Math.max(0, Math.min(100, (w.remaining / w.capacity) * 100)) : 0;
  const level = leftPct <= 10 ? 'crit' : leftPct <= 30 ? 'warn' : 'ok';
  const runsOut = w.exhaustedAt ? Date.parse(w.exhaustedAt) - now : null;
  const resetIn = w.nextResetAt ? Date.parse(w.nextResetAt) - now : null;
  return (
    <div className="burn-row" title={hint}>
      <div className="burn-row-head">
        <span className="tile-label">{label}</span>
        <span className={`burn-eta lvl-${runsOut === null ? 'ok' : level}`}>
          {runsOut === null ? 'never' : `stops in ${formatDuration(Math.max(0, runsOut))}`}
        </span>
      </div>
      <div
        className="usage-track"
        role="meter"
        aria-label={`${label} headroom`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(leftPct)}
      >
        <div className={`usage-fill fill-${level}`} style={{ width: `${leftPct}%` }} />
      </div>
      <span className="tile-sub">
        {Math.round(leftPct)}% left
        {w.rate > 0 ? ` · spending ${rateText(w)}` : ' · nothing being spent'}
        {resetIn !== null && ` · first reset in ${formatDuration(Math.max(0, resetIn))}`}
      </span>
    </div>
  );
}

/**
 * The rate as a share of everything the desk has, per hour. Capacity units are the honest unit but
 * mean nothing on their own; against the pool they read as "an eighth of everything, every hour".
 */
function rateText(w: BurnWindow): string {
  const perHour = w.capacity > 0 ? (w.rate / w.capacity) * 100 : 0;
  return `${perHour < 1 ? perHour.toFixed(1) : Math.round(perHour)}% of the pool an hour`;
}
