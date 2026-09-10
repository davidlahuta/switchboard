import { useEffect, useId, useState, type FormEvent } from 'react';
import type { CreateRunRequest, Run, StateSnapshot } from '@shared/types.ts';
import { api, request } from '../lib/api.ts';
import { subUsageShort, usableSubs } from '../lib/format.ts';
import { navigate, href } from '../lib/router.ts';
import { timeAgo } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';
import { Dialog } from './ui.tsx';

interface RecentSession {
  id: string;
  title: string;
  mtime: string | number;
}

function mtimeIso(m: string | number): string {
  return typeof m === 'number' ? new Date(m).toISOString() : m;
}

export function NewSessionDialog({
  open,
  onClose,
  state,
  initialCwd,
}: {
  open: boolean;
  onClose: () => void;
  state: StateSnapshot;
  initialCwd?: string;
}) {
  const listId = useId();
  const [cwd, setCwd] = useState('');
  const [sub, setSub] = useState('auto');
  const [name, setName] = useState('');
  const [worktree, setWorktree] = useState('');
  const [resume, setResume] = useState('');
  const [autoSwap, setAutoSwap] = useState(state.settings.autoSwap);
  const [recent, setRecent] = useState<RecentSession[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCwd(initialCwd ?? state.repos[0]?.root ?? '');
    setSub('auto');
    setName('');
    setWorktree('');
    setResume('');
    setAutoSwap(state.settings.autoSwap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // recent sessions for the chosen directory (debounced)
  useEffect(() => {
    if (!open) return;
    setRecent(null);
    setResume('');
    const dir = cwd.trim();
    if (!dir) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      request<RecentSession[]>('GET', `/api/sessions/recent?cwd=${encodeURIComponent(dir)}`)
        .then((r) => !cancelled && setRecent(Array.isArray(r) ? r : []))
        .catch(() => !cancelled && setRecent([]));
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [cwd, open]);

  const subs = usableSubs(state.subscriptions);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const dir = cwd.trim();
    if (!dir) {
      emitToast('warn', 'Choose a directory');
      return;
    }
    const body: CreateRunRequest = {
      cwd: dir,
      subscriptionId: sub,
      autoSwap,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(worktree.trim() ? { worktree: worktree.trim() } : {}),
      ...(resume ? { resumeSessionId: resume } : {}),
    };
    setBusy(true);
    const run = await api.post<Run>('/api/runs', body);
    setBusy(false);
    if (!run) return;
    emitToast('success', `Started ${run.name} on ${run.subscriptionLabel}`);
    onClose();
    navigate(href.terminal(run.id));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New session"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-session-form" className="btn btn-primary" disabled={busy || !cwd.trim()}>
            {busy ? 'Starting…' : 'Start session'}
          </button>
        </>
      }
    >
      <form id="new-session-form" className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Directory</span>
          <input
            type="text"
            className="input mono"
            list={listId}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\\src\\my-repo"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
          />
          <datalist id={listId}>
            {state.repos.map((r) => (
              <option key={r.id} value={r.root}>
                {r.name}
              </option>
            ))}
          </datalist>
        </label>

        <label className="field">
          <span className="field-label">Subscription</span>
          <select className="input" value={sub} onChange={(e) => setSub(e.target.value)}>
            <option value="auto">Auto (most headroom)</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {subUsageShort(s)}
              </option>
            ))}
          </select>
          {subs.length === 0 && <span className="field-hint warn">No ready subscriptions. Add or log in on the Subscriptions page.</span>}
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">Name <span className="optional">optional</span></span>
            <input type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="auth refactor" />
          </label>
          <label className="field">
            <span className="field-label">New worktree <span className="optional">optional</span></span>
            <input
              type="text"
              className="input mono"
              value={worktree}
              onChange={(e) => setWorktree(e.target.value)}
              placeholder="feature-x"
              autoCapitalize="off"
              spellCheck={false}
              disabled={!!resume}
            />
          </label>
        </div>

        <label className="field">
          <span className="field-label">Resume session <span className="optional">optional</span></span>
          <select className="input" value={resume} onChange={(e) => setResume(e.target.value)} disabled={!recent || recent.length === 0}>
            <option value="">{recent === null ? (cwd.trim() ? 'Looking for sessions…' : 'Start fresh') : recent.length ? 'Start fresh' : 'No previous sessions here'}</option>
            {recent?.map((r) => (
              <option key={r.id} value={r.id}>
                {(r.title || r.id).slice(0, 70)} · {timeAgo(mtimeIso(r.mtime))}
              </option>
            ))}
          </select>
        </label>

        <label className="check">
          <input type="checkbox" checked={autoSwap} onChange={(e) => setAutoSwap(e.target.checked)} />
          <span>
            Auto-swap on limits
            <span className="field-hint">Resume on the subscription with the most headroom when this one runs out.</span>
          </span>
        </label>

        {!state.daemon.wtAvailable && (
          <p className="field-hint warn">Windows Terminal was not detected; the daemon may not be able to open a tab.</p>
        )}
      </form>
    </Dialog>
  );
}
