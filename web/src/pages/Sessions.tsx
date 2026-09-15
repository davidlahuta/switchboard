import { Fragment, useEffect, useRef, useState } from 'react';
import type { Repo, Run, StateSnapshot } from '@shared/types.ts';
import { byAttention, GROUP_HINT, GROUP_LABEL, liveState, liveTone, sessionGroup, sessionMark, type SessionGroup } from '@shared/marks.ts';
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
import { href, navigate, REPO_ALL, repoFilterOf, terminalLink } from '../lib/router.ts';
import { absTime, timeAgo, useNow } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';

/** Where the repository filter is kept between visits; see the effect that restores it. */
const REPO_KEY = 'sb.sessions.repo';

function remembered(): string | null {
  try {
    return localStorage.getItem(REPO_KEY);
  } catch {
    return null;
  }
}

export function Sessions({ state, repo }: { state: StateSnapshot; repo: string | null }) {
  const now = useNow(10_000);
  const [newOpen, setNewOpen] = useState(false);
  const [stopping, setStopping] = useState<Run | null>(null);
  const [showExited, setShowExited] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  /*
   * The filter lives in the URL, so it survives a reload, a link sent to a phone, and the back
   * button — and so the page cannot be showing three of nine sessions with nothing to say why.
   * It is also remembered, because "sticky" means across visits and not only across reloads: the
   * nav link goes to a bare #/sessions, and arriving there with a filter still set and invisible
   * would be the worst of both. So the remembered one is put back into the URL rather than applied
   * behind it, and what the address bar says is always what the list is doing.
   */
  const repoFilter = repoFilterOf(repo);
  useEffect(() => {
    if (repo !== null) return;
    const last = remembered();
    if (last !== null && last !== REPO_ALL) navigate(href.sessions(last), true);
  }, [repo]);
  const setRepoFilter = (next: string) => {
    try {
      if (next === REPO_ALL) localStorage.removeItem(REPO_KEY);
      else localStorage.setItem(REPO_KEY, next);
    } catch {
      /* a browser that refuses storage still gets the URL */
    }
    navigate(href.sessions(next));
  };

  const runs = [...state.runs].sort(byAttention(now));
  const repoOf = (r: Run) => r.repoId ?? '';
  const usedRepos = state.repos.filter((repo) => runs.some((r) => r.repoId === repo.id));
  const hasLoose = runs.some((r) => !r.repoId);
  const filtered = repoFilter !== REPO_ALL;
  const inRepo = filtered ? runs.filter((r) => repoOf(r) === repoFilter) : runs;
  const visible = showExited ? inRepo : inRepo.filter((r) => r.status !== 'exited');
  const exitedCount = inRepo.filter((r) => r.status === 'exited').length;
  const filterName = !filtered ? null : (state.repos.find((x) => x.id === repoFilter)?.name ?? 'outside a repository');
  const markOf = (r: Run): string => sessionMark(r)?.glyph ?? '';
  const groupOf = (r: Run): SessionGroup => sessionGroup(r, now);
  // Rows slide to their new places rather than jumping there, and light up when they change; see
  // lib/reorder.ts. Which rows are open counts as part of the layout: opening one moves the others,
  // and so does a row changing group, which is the only thing that moves one now.
  const list = useRef<HTMLUListElement>(null);
  useReorder(
    list,
    orderOf(visible.map((r) => ({ id: r.id, mark: markOf(r), state: `${liveState(r)}/${groupOf(r)}/${open.has(r.id) ? 'open' : ''}` }))),
  );

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
        subtitle={
          filtered ? (
            /* Not only the select: a filtered list that looks like the whole list is how you come
               back an hour later and conclude six sessions have died. */
            <>
              Showing <b>{visible.length}</b> of {runs.length} — filtered to <b>{filterName}</b>{' '}
              <button type="button" className="link-btn" onClick={() => setRepoFilter(REPO_ALL)}>
                show all
              </button>
            </>
          ) : (
            'Claude Code sessions hosted by Switchboard'
          )
        }
        actions={
          <>
            {runs.length > 0 && (
              <label className={`check check-inline filter-pick${filtered ? ' is-on' : ''}`}>
                <span className="sr-only">Filter by repository</span>
                <select
                  className="input select-inline"
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  aria-label="Filter by repository"
                >
                  <option value={REPO_ALL}>All repositories</option>
                  {usedRepos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.name}
                    </option>
                  ))}
                  {hasLoose && <option value="">Outside a repository</option>}
                </select>
                {filtered && (
                  <button
                    type="button"
                    className="btn btn-sm filter-clear"
                    onClick={() => setRepoFilter(REPO_ALL)}
                    aria-label="Clear the repository filter"
                    title="Clear the repository filter"
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
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
          {filtered ? 'No sessions in that repository. ' : 'No sessions. '}
          <button type="button" className="link-btn" onClick={() => setNewOpen(true)}>
            Start one
          </button>{' '}
          — it opens in a Windows Terminal tab and is mirrored here.
        </Empty>
      ) : (
        <ul className="srows" ref={list}>
          {visible.map((r, i) => {
            /* A heading wherever the group changes. The order is the answer to "what should I look
               at first", and a heading is what turns that from a rule the reader has to infer into
               one they can see — and it is why a row that moves is worth noticing: it has changed
               what it wants, not merely fired a hook. */
            const group = groupOf(r);
            const opens = i === 0 || groupOf(visible[i - 1]) !== group;
            return (
              <Fragment key={r.id}>
                {opens && (
                  <li className="srow-group" title={GROUP_HINT[group]}>
                    <span className={`srow-group-label group-${group}`}>{GROUP_LABEL[group]}</span>
                    <span className="srow-group-count">{visible.filter((x) => groupOf(x) === group).length}</span>
                  </li>
                )}
                <SessionRow
                  run={r}
                  repo={r.repoId ? state.repos.find((x) => x.id === r.repoId) : undefined}
                  state={state}
                  now={now}
                  mark={markOf(r)}
                  expanded={open.has(r.id)}
                  onToggle={() => toggle(r.id)}
                  onStop={() => setStopping(r)}
                />
              </Fragment>
            );
          })}
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
 * changes: the mark, the name, what it is doing, and the two actions worth taking on a session you
 * are only glancing at — open it, or tell it to carry on. Everything that is a decision rather than
 * a reflex, restarting included, is a click away with the rest of what a session is: where it
 * lives, which subscription, its id, its settings, its swaps. None of that changes from minute to
 * minute, and none of it is why anybody opens this page.
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

        <SessionName run={r} linked dot />

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
          <a className="btn btn-sm btn-icon" {...terminalLink(r.id)} aria-label={`Open terminal for ${r.name}`} title="Terminal">
            <Icon name="terminal" size={16} />
          </a>
          {/* No terminal of its own: exited on its own, or the machine was off. */}
          {(exited || r.status === 'disconnected') && <ResumeButton run={r} compact />}
          {!exited && <ContinueButton run={r} compact />}
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
            {!exited && <RestartMenu run={r} compact />}
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
