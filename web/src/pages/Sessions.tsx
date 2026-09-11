import { useRef, useState } from 'react';
import type { Repo, Run, StateSnapshot } from '@shared/types.ts';
import { byAttention } from '../components/AttentionDot.tsx';
import { liveState, liveTone, sessionMark } from '@shared/marks.ts';
import { triggerLabel } from '@shared/respawn.ts';
import { orderOf, useReorder } from '../lib/reorder.ts';
import { NewSessionDialog } from '../components/NewSessionDialog.tsx';
import { ContinueButton } from '../components/ContinueButton.tsx';
import { HandoffButton } from '../components/HandoffButton.tsx';
import { SessionName } from '../components/SessionName.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { RestartMenu } from '../components/RestartMenu.tsx';
import { ResumeButton } from '../components/ResumeButton.tsx';
import { RunArgs, RunTags } from '../components/RunTags.tsx';
import { SwapMenu } from '../components/SwapMenu.tsx';
import { Badge, ConfirmDialog, Empty, Icon, StatusPill } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { shortPath } from '../lib/format.ts';
import { href } from '../lib/router.ts';
import { absTime, timeAgo, useNow } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';

export function Sessions({ state }: { state: StateSnapshot }) {
  const now = useNow(10_000);
  const [newOpen, setNewOpen] = useState(false);
  const [stopping, setStopping] = useState<Run | null>(null);
  const [showExited, setShowExited] = useState(true);
  const [repoFilter, setRepoFilter] = useState('all');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const runs = [...state.runs].sort(byAttention);
  const repoOf = (r: Run) => r.repoId ?? '';
  const usedRepos = state.repos.filter((repo) => runs.some((r) => r.repoId === repo.id));
  const hasLoose = runs.some((r) => !r.repoId);
  const inRepo = repoFilter === 'all' ? runs : runs.filter((r) => repoOf(r) === repoFilter);
  const visible = showExited ? inRepo : inRepo.filter((r) => r.status !== 'exited');
  const exitedCount = inRepo.filter((r) => r.status === 'exited').length;
  const markOf = (r: Run): string => sessionMark(r)?.glyph ?? '';
  // Rows slide to their new places rather than jumping there, and light up when they change; see
  // lib/reorder.ts. Which rows are open counts as part of the layout: opening one moves the others.
  const list = useRef<HTMLUListElement>(null);
  useReorder(list, orderOf(visible.map((r) => ({ id: r.id, mark: markOf(r), state: `${liveState(r)}/${open.has(r.id) ? 'open' : ''}` }))));

  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const stop = async () => {
    if (!stopping) return;
    const r = stopping;
    setStopping(null);
    if (await api.post(`/api/runs/${encodeURIComponent(r.id)}/stop`)) emitToast('info', `Stopping ${r.name}`);
  };

  return (
    <div className="page">
      <PageHead
        title="Sessions"
        subtitle="Claude Code sessions hosted by Switchboard"
        actions={
          <>
            {runs.length > 0 && (
              <label className="check check-inline">
                <span className="sr-only">Filter by repository</span>
                <select className="input select-inline" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} aria-label="Filter by repository">
                  <option value="all">All repositories</option>
                  {usedRepos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.name}
                    </option>
                  ))}
                  {hasLoose && <option value="">Outside a repository</option>}
                </select>
              </label>
            )}
            {exitedCount > 0 && (
              <label className="check check-inline">
                <input type="checkbox" checked={showExited} onChange={(e) => setShowExited(e.target.checked)} />
                <span>Show exited ({exitedCount})</span>
              </label>
            )}
            <button type="button" className="btn btn-primary" onClick={() => setNewOpen(true)}>
              <Icon name="plus" size={16} />
              New session
            </button>
          </>
        }
      />

      {visible.length === 0 ? (
        <Empty icon="terminal">
          {repoFilter !== 'all' ? 'No sessions in that repository. ' : 'No sessions. '}
          <button type="button" className="link-btn" onClick={() => setNewOpen(true)}>
            Start one
          </button>{' '}
          — it opens in a Windows Terminal tab and is mirrored here.
        </Empty>
      ) : (
        <ul className="srows" ref={list}>
          {visible.map((r) => (
            <SessionRow
              key={r.id}
              run={r}
              repo={r.repoId ? state.repos.find((x) => x.id === r.repoId) : undefined}
              state={state}
              now={now}
              mark={markOf(r)}
              expanded={open.has(r.id)}
              onToggle={() => toggle(r.id)}
              onStop={() => setStopping(r)}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!stopping}
        title={`Stop ${stopping?.name ?? 'session'}?`}
        confirmLabel="Stop session"
        danger
        onConfirm={() => void stop()}
        onCancel={() => setStopping(null)}
      >
        <p>
          Claude Code will be terminated and its Windows Terminal tab closes. The conversation stays on disk and can be resumed from
          “New session → Session”.
        </p>
      </ConfirmDialog>

      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} state={state} />
    </div>
  );
}

/**
 * One session, in one line.
 *
 * A desk runs nine of these and a phone shows a screen at a time, so what is always visible is what
 * changes: the mark, the name, what it is doing, and the handful of actions worth taking on a
 * session you are only glancing at — open it, tell it to carry on, restart it, bring it back. The
 * rest of what a session is — where it lives, which subscription, its id, its settings, its swaps —
 * does not change from minute to minute and is a click away.
 */
function SessionRow({
  run,
  repo,
  state,
  now,
  mark,
  expanded,
  onToggle,
  onStop,
}: {
  run: Run;
  repo: Repo | undefined;
  state: StateSnapshot;
  now: number;
  mark: string;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
}) {
  const exited = run.status === 'exited';
  const r = run;
  return (
    <li
      className={exited ? 'srow row-muted' : 'srow'}
      data-reorder-key={r.id}
      data-mark={mark}
      data-state={liveState(r)}
      data-tone={liveTone(r)}
    >
      {/* Clicking the row opens it; clicking anything in it does its own thing. */}
      <div
        className="srow-head"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a, button, input, select, summary')) return;
          onToggle();
        }}
      >
        <button
          type="button"
          className="srow-toggle"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Hide details for ${r.name}` : `Show details for ${r.name}`}
        >
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>

        <SessionName run={r} href={href.terminal(r.id)} dot />

        <span className="srow-live">
          {r.agentStatus && !exited && <StatusPill status={r.agentStatus} title="Agent status" />}
          {(exited || r.status !== 'running') && <StatusPill status={r.status} title="Run status" />}
          {exited && r.exitCode !== null && <Badge tone={r.exitCode === 0 ? 'muted' : 'crit'}>exit {r.exitCode}</Badge>}
          <RunTags run={r} models={state.models} update={state.update} compact />
        </span>

        <span className="srow-time" title={`session ${r.sessionId}, started ${absTime(r.createdAt)}`}>
          {exited && r.endedAt ? `ended ${timeAgo(r.endedAt, now)}` : timeAgo(r.lastActivity, now)}
        </span>

        <span className="srow-actions">
          <a className="btn btn-sm btn-icon" href={href.terminal(r.id)} aria-label={`Open terminal for ${r.name}`} title="Terminal">
            <Icon name="terminal" size={16} />
          </a>
          {/* No terminal of its own: exited on its own, or the machine was off. */}
          {(exited || r.status === 'disconnected') && <ResumeButton run={r} compact />}
          {!exited && <ContinueButton run={r} compact />}
          {!exited && <RestartMenu run={r} compact />}
        </span>
      </div>

      {expanded && (
        <div className="srow-detail">
          <dl className="srow-facts">
            <dt>Where</dt>
            <dd>
              {repo && <a href={href.repo(repo.id)}>{repo.name}</a>}{' '}
              <span className="mono dim small" title={r.cwd}>
                {shortPath(r.cwd, 2)}
              </span>
              {r.cwdMissing && (
                <Badge tone="warn" title={`${r.cwd} no longer exists, so this session cannot be opened there`}>
                  folder gone
                </Badge>
              )}
            </dd>
            <dt>Subscription</dt>
            <dd>
              {r.subscriptionLabel}
              {r.autoSwap && (
                <span className="auto-swap" title="Auto-swap on limits is on" aria-label="Auto-swap on">
                  <Icon name="bolt" size={12} />
                  auto
                </span>
              )}
            </dd>
            <dt>Session</dt>
            <dd className="mono dim small" title={`started ${absTime(r.createdAt)}`}>
              {r.sessionId}
            </dd>
            <dt>Swaps</dt>
            <dd>
              {r.swapCount > 0 ? (
                <span title={r.lastSwap ? `${absTime(r.lastSwap.ts)} — ${r.lastSwap.reason}` : undefined}>
                  {r.swapCount}
                  {r.lastSwap && (
                    <span className="dim small">
                      {' '}
                      · {r.lastSwap.trigger ? triggerLabel(r.lastSwap.trigger) : r.lastSwap.reason} {timeAgo(r.lastSwap.ts, now)}
                    </span>
                  )}
                </span>
              ) : (
                <span className="dim">none</span>
              )}
            </dd>
          </dl>
          <RunTags run={r} models={state.models} update={state.update} />
          <RunArgs args={r.args} />
          <div className="row-actions">
            {!exited && <SwapMenu run={r} subs={state.subscriptions} compact />}
            {!exited && <HandoffButton run={r} compact />}
            {!exited ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={onStop} aria-label={`Stop ${r.name}`} title="Stop">
                <Icon name="stop" size={14} />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void api.del(`/api/runs/${encodeURIComponent(r.id)}`)}
                aria-label={`Forget ${r.name}`}
                title="Forget"
              >
                <Icon name="trash" size={14} />
                <span>Forget</span>
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
