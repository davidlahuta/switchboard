import { useState } from 'react';
import type { Run, StateSnapshot } from '@shared/types.ts';
import { NewSessionDialog } from '../components/NewSessionDialog.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { RestartMenu } from '../components/RestartMenu.tsx';
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

  const runs = [...state.runs].sort(
    (a, b) => Number(a.status === 'exited') - Number(b.status === 'exited') || b.createdAt.localeCompare(a.createdAt),
  );
  const visible = showExited ? runs : runs.filter((r) => r.status !== 'exited');
  const exitedCount = runs.filter((r) => r.status === 'exited').length;

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
          No sessions.{' '}
          <button type="button" className="link-btn" onClick={() => setNewOpen(true)}>
            Start one
          </button>{' '}
          — it opens in a Windows Terminal tab and is mirrored here.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="rtable sessions-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Repo / directory</th>
                <th>Subscription</th>
                <th>Status</th>
                <th>Swaps</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const repo = r.repoId ? state.repos.find((x) => x.id === r.repoId) : undefined;
                const exited = r.status === 'exited';
                return (
                  <tr key={r.id} className={exited ? 'row-muted' : undefined}>
                    <td data-label="Session" className="cell-title">
                      <a href={href.terminal(r.id)} className="run-name">
                        {r.name}
                      </a>
                      {r.autoSwap && (
                        <span className="auto-swap" title="Auto-swap on limits is on" aria-label="Auto-swap on">
                          <Icon name="bolt" size={12} />
                          auto
                        </span>
                      )}
                      <span className="mono dim small" title={`session ${r.sessionId}`}>
                        {r.sessionId.slice(0, 8)} · {exited && r.endedAt ? `ended ${timeAgo(r.endedAt, now)}` : `started ${timeAgo(r.createdAt, now)}`}
                      </span>
                      <RunTags run={r} models={state.models} update={state.update} />
                      <RunArgs args={r.args} />
                    </td>
                    <td data-label="Repo">
                      {repo ? (
                        <a href={href.repo(repo.id)}>{repo.name}</a>
                      ) : null}
                      <span className="mono dim small" title={r.cwd}>
                        {' '}
                        {shortPath(r.cwd, 2)}
                      </span>
                    </td>
                    <td data-label="Subscription">{r.subscriptionLabel}</td>
                    <td data-label="Status">
                      <span className="pill-stack">
                        <StatusPill status={r.status} title="Run status" />
                        {r.agentStatus && r.status !== 'exited' && <StatusPill status={r.agentStatus} title="Agent status" />}
                        {exited && r.exitCode !== null && (
                          <Badge tone={r.exitCode === 0 ? 'muted' : 'crit'}>exit {r.exitCode}</Badge>
                        )}
                      </span>
                    </td>
                    <td data-label="Swaps">
                      {r.swapCount > 0 ? (
                        <span title={r.lastSwap ? absTime(r.lastSwap.ts) : undefined}>
                          {r.swapCount}
                          {r.lastSwap && <span className="dim small"> · {r.lastSwap.reason} {timeAgo(r.lastSwap.ts, now)}</span>}
                        </span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        <a className="btn btn-sm" href={href.terminal(r.id)} aria-label={`Open terminal for ${r.name}`}>
                          <Icon name="terminal" size={16} />
                          <span>Terminal</span>
                        </a>
                        {!exited && <SwapMenu run={r} subs={state.subscriptions} compact />}
                        {!exited && <RestartMenu run={r} compact />}
                        {!exited ? (
                          <button type="button" className="btn btn-sm btn-danger" onClick={() => setStopping(r)}>
                            <Icon name="stop" size={14} />
                            <span>Stop</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => void api.del(`/api/runs/${encodeURIComponent(r.id)}`)}
                            aria-label={`Forget ${r.name}`}
                          >
                            <Icon name="trash" size={14} />
                            <span>Forget</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
