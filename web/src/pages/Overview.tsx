import { useRef, useState } from 'react';
import type { Run, StateSnapshot, Subscription } from '@shared/types.ts';
import { AttentionDot, byAttention } from '../components/AttentionDot.tsx';
import { BurnPanel } from '../components/BurnPanel.tsx';
import { liveState, liveTone, sessionMark } from '@shared/marks.ts';
import { orderOf, useReorder } from '../lib/reorder.ts';
import { NewSessionDialog } from '../components/NewSessionDialog.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { RestartMenu } from '../components/RestartMenu.tsx';
import { RunTags } from '../components/RunTags.tsx';
import { SwapMenu } from '../components/SwapMenu.tsx';
import { Badge, Empty, Icon, Section, StaleBadge, StatusPill, UsageBar } from '../components/ui.tsx';
import { planLabel, shortPath, subStatusLabel, usageLevel } from '../lib/format.ts';
import { href } from '../lib/router.ts';
import { timeAgo, useNow } from '../lib/time.ts';

export function Overview({ state }: { state: StateSnapshot }) {
  const now = useNow(1000);
  const [newOpen, setNewOpen] = useState(false);
  const { totals } = state;
  const liveRuns = state.runs.filter((r) => r.status !== 'exited').sort(byAttention);
  // Rows slide to their new places rather than jumping there; see lib/reorder.ts.
  const liveList = useRef<HTMLUListElement>(null);
  useReorder(liveList, orderOf(liveRuns.map((r) => ({ id: r.id, mark: sessionMark(r)?.glyph ?? '', state: liveState(r) }))));
  // Most immediately usable first: headroom already accounts for both windows and plan size.
  // Exhausted ones tie at zero, so break that by which frees up soonest — a spent 5-hour window
  // is back in hours, a spent weekly one in days.
  const recoversAt = (s: Subscription): number => {
    const w = s.bindingWindow === 'sevenDay' ? s.usage?.sevenDay : s.usage?.fiveHour;
    return w?.resetsAt ? Date.parse(w.resetsAt) : Number.POSITIVE_INFINITY;
  };
  const subs = [...state.subscriptions].sort(
    (a, b) =>
      b.headroom - a.headroom ||
      Number(b.enabled) - Number(a.enabled) ||
      recoversAt(a) - recoversAt(b) ||
      a.priority - b.priority ||
      a.label.localeCompare(b.label),
  );

  return (
    <div className="page">
      <PageHead
        title="Overview"
        subtitle={`${state.repos.length} repos · ${state.subscriptions.length} subscriptions`}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={16} />
            New session
          </button>
        }
      />

      <div className="totals">
        <HeadroomTile label="5h headroom" remaining={totals.fiveHourRemaining} capacity={totals.capacity} />
        <HeadroomTile label="7d headroom" remaining={totals.sevenDayRemaining} capacity={totals.capacity} />
        <a className="tile tile-link" href={href.sessions()}>
          <span className="tile-label">Live sessions</span>
          <span className="tile-value">{totals.liveRuns}</span>
          <span className="tile-sub">{state.runs.length - liveRuns.length} exited</span>
        </a>
        <div className="tile">
          <span className="tile-label">Agents online</span>
          <span className="tile-value">{totals.agentsOnline}</span>
          <span className="tile-sub">across {state.repos.filter((r) => r.agentsOnline > 0).length} repos</span>
        </div>
      </div>

      <BurnPanel burn={state.burn} subs={state.subscriptions} now={now} />

      <Section
        title="Subscriptions"
        count={subs.length}
        actions={
          <a className="btn btn-sm btn-ghost" href={href.subscriptions()}>
            Manage
          </a>
        }
      >
        {subs.length === 0 ? (
          <Empty icon="card">
            No subscriptions yet. <a href={href.subscriptions()}>Add one</a>.
          </Empty>
        ) : (
          <div className="sub-grid">
            {subs.map((s, i) => (
              <SubUsageCard key={s.id} sub={s} now={now} rank={i} />
            ))}
          </div>
        )}
      </Section>

      <div className="two-col">
        <Section title="Repos" count={state.repos.length}>
          {state.repos.length === 0 ? (
            <Empty icon="repo">No repos yet. They appear as soon as a Claude Code session with Switchboard starts in one.</Empty>
          ) : (
            <ul className="list">
              {[...state.repos]
                .sort((a, b) => b.agentsOnline - a.agentsOnline || (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
                .map((r) => (
                  <li key={r.id}>
                    <a className="list-row" href={href.repo(r.id)}>
                      <span className={r.agentsOnline > 0 ? 'repo-dot on' : 'repo-dot'} aria-hidden="true" />
                      <span className="list-main">
                        <span className="list-title">{r.name}</span>
                        <span className="list-sub mono" title={r.root}>
                          {shortPath(r.root, 3)}
                        </span>
                      </span>
                      <span className="list-badges">
                        {r.openConflicts > 0 && (
                          <Badge tone="crit" title="Open conflicts">
                            {r.openConflicts} conflict{r.openConflicts > 1 ? 's' : ''}
                          </Badge>
                        )}
                        {r.unreadForHuman > 0 && (
                          <Badge tone="accent" title="Unread messages for you">
                            {r.unreadForHuman} unread
                          </Badge>
                        )}
                        <Badge tone={r.agentsOnline > 0 ? 'ok' : 'muted'} title="Agents online / total">
                          {r.agentsOnline}/{r.agentsTotal} agents
                        </Badge>
                        <span className="list-time">{timeAgo(r.lastActivity, now)}</span>
                      </span>
                    </a>
                  </li>
                ))}
            </ul>
          )}
        </Section>

        <Section
          title="Live sessions"
          count={liveRuns.length}
          actions={
            <a className="btn btn-sm btn-ghost" href={href.sessions()}>
              All
            </a>
          }
        >
          {liveRuns.length === 0 ? (
            <Empty icon="terminal">
              No live sessions.{' '}
              <button type="button" className="link-btn" onClick={() => setNewOpen(true)}>
                Start one
              </button>
              .
            </Empty>
          ) : (
            <ul className="list" ref={liveList}>
              {liveRuns.map((r) => (
                <LiveRunRow key={r.id} run={r} state={state} />
              ))}
            </ul>
          )}
        </Section>
      </div>

      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} state={state} />
    </div>
  );
}

function HeadroomTile({ label, remaining, capacity }: { label: string; remaining: number; capacity: number }) {
  const pct = capacity > 0 ? Math.max(0, Math.min(100, (remaining / capacity) * 100)) : 0;
  // Headroom is the inverse of utilisation: low headroom = critical.
  const level = usageLevel(100 - pct);
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className={`tile-value lvl-${capacity > 0 ? level : 'ok'}`}>{capacity > 0 ? `${Math.round(pct)}%` : '—'}</span>
      <div className="usage-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className={`usage-fill fill-${level}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tile-sub" title="Weighted by plan size (Pro = 1, Max 5× = 5, Max 20× = 20)">
        {capacity > 0 ? `${fmtUnits(remaining)} of ${fmtUnits(capacity)} capacity units` : 'no ready subscriptions'}
      </span>
    </div>
  );
}

function fmtUnits(n: number): string {
  return n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');
}

function SubUsageCard({ sub, now, rank }: { sub: Subscription; now: number; rank: number }) {
  const u = sub.usage;
  // The same answer the daemon gives: a subscription signed into another account has headroom
  // that belongs to that account, so this card shows none and says why instead.
  const usable = sub.enabled && sub.status === 'ready' && !sub.accountMismatch;
  return (
    <a className={sub.enabled ? 'card sub-card' : 'card sub-card disabled'} href={href.subscriptions()}>
      <div className="card-head">
        <span className="card-title">
          {rank === 0 && usable && sub.headroom > 0 && (
            <span className="rank-pip" title="Most usage available right now">
              ★
            </span>
          )}
          {sub.label}
        </span>
        <Badge tone="neutral">{planLabel(sub)}</Badge>
      </div>
      <div className="sub-headroom" title="Usable right now, weighted by plan size and capped by the tighter of the two windows">
        <span className="sub-headroom-value">{usable ? fmtUnits(sub.headroom) : '—'}</span>
        <span className="sub-headroom-label">of {fmtUnits(sub.weight)} units free</span>
      </div>
      <div className="card-meta">
        {sub.accountMismatch ? (
          <Badge tone="crit" title={`This subscription is for ${sub.email}, but its token is for ${sub.accountEmail}. These numbers are ${sub.accountEmail}'s.`}>
            wrong account
          </Badge>
        ) : sub.status !== 'ready' ? (
          <Badge tone={sub.status === 'error' ? 'crit' : 'warn'}>{subStatusLabel(sub.status)}</Badge>
        ) : !sub.enabled ? (
          <Badge tone="muted">disabled</Badge>
        ) : (
          <StaleBadge usage={u} now={now} />
        )}
        <span className="muted">{sub.liveRuns} live</span>
      </div>
      <UsageBar label="5h" window={u?.fiveHour} now={now} binding={usable && sub.bindingWindow === 'fiveHour'} />
      <UsageBar label="7d" window={u?.sevenDay} now={now} binding={usable && sub.bindingWindow === 'sevenDay'} />
    </a>
  );
}

function LiveRunRow({ run, state }: { run: Run; state: StateSnapshot }) {
  const repo = run.repoId ? state.repos.find((r) => r.id === run.repoId) : undefined;
  return (
    <li
      className="list-row run-row"
      data-reorder-key={run.id}
      data-mark={sessionMark(run)?.glyph ?? ''}
      data-state={liveState(run)}
      data-tone={liveTone(run)}
    >
      <a className="list-main" href={href.terminal(run.id)}>
        <span className="list-title">
          <AttentionDot run={run} />
          {run.name}
          {run.autoSwap && (
            <span className="auto-swap" title="Auto-swap on limits">
              <Icon name="bolt" size={12} />
            </span>
          )}
        </span>
        <span className="list-sub">
          <span className="mono">{repo?.name ?? shortPath(run.cwd)}</span> · {run.subscriptionLabel}
        </span>
      </a>
      <span className="list-badges">
        <RunTags run={run} models={state.models} update={state.update} compact />
        <StatusPill status={run.agentStatus ?? run.status} title={`run: ${run.status}`} />
      </span>
      {/* The same icon-only actions the sessions table uses: labels stay in the markup for screen
          readers and come back inside the menus, where there is room to read them. */}
      <span className="row-actions">
        <a className="btn btn-sm" href={href.terminal(run.id)} aria-label={`Open terminal for ${run.name}`} title="Terminal">
          <Icon name="terminal" size={16} />
          <span>Terminal</span>
        </a>
        <SwapMenu run={run} subs={state.subscriptions} compact />
        <RestartMenu run={run} compact />
      </span>
    </li>
  );
}
