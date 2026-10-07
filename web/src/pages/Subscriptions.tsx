import { useEffect, useState, type FormEvent } from 'react';
import type { StateSnapshot, Subscription, UsagePoint } from '@shared/types.ts';
import { PageHead } from '../components/PageHead.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { Badge, ConfirmDialog, Dialog, Empty, Icon, IconButton, StaleBadge, Toggle, UsageBar } from '../components/ui.tsx';
import { api, request } from '../lib/api.ts';
import { isRateLimited, planLabel, subStatusLabel } from '../lib/format.ts';
import { absTime, retryIn, timeAgo, useNow } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';

export function Subscriptions({ state }: { state: StateSnapshot }) {
  const now = useNow(1000);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<Subscription | null>(null);
  const subs = [...state.subscriptions].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="page">
      <PageHead
        title="Subscriptions"
        subtitle="Each subscription is an isolated Claude login used for new sessions and swaps"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={16} />
            Add subscription
          </button>
        }
      />

      {subs.length === 0 ? (
        <Empty icon="card">No subscriptions. Add one to start sessions.</Empty>
      ) : (
        <div className="sub-list">
          {subs.map((s) => (
            <SubscriptionCard key={s.id} sub={s} now={now} onRemove={() => setRemoving(s)} />
          ))}
        </div>
      )}

      <AddSubscriptionDialog open={addOpen} onClose={() => setAddOpen(false)} subs={state.subscriptions} />
      <RemoveDialog sub={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

function SubscriptionCard({ sub, now, onRemove }: { sub: Subscription; now: number; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(sub.label);
  const [priority, setPriority] = useState(String(sub.priority));
  const [history, setHistory] = useState<UsagePoint[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const u = sub.usage;
  const id = encodeURIComponent(sub.id);
  // While rate limited the daemon refuses early refreshes, so the button would only produce an error.
  const limited = isRateLimited(u, now);

  useEffect(() => setPriority(String(sub.priority)), [sub.priority]);
  useEffect(() => {
    if (!editing) setLabel(sub.label);
  }, [sub.label, editing]);

  useEffect(() => {
    let cancelled = false;
    request<UsagePoint[]>('GET', `/api/subscriptions/${id}/history?hours=48`)
      .then((h) => !cancelled && setHistory(Array.isArray(h) ? h : []))
      .catch(() => !cancelled && setHistory([]));
    return () => {
      cancelled = true;
    };
  }, [id, u?.fetchedAt]);

  const saveLabel = async (e?: FormEvent) => {
    e?.preventDefault();
    const v = label.trim();
    setEditing(false);
    if (!v || v === sub.label) {
      setLabel(sub.label);
      return;
    }
    await api.patch(`/api/subscriptions/${id}`, { label: v });
  };

  const savePriority = async () => {
    const n = Number(priority);
    if (!Number.isFinite(n) || n === sub.priority) {
      setPriority(String(sub.priority));
      return;
    }
    await api.patch(`/api/subscriptions/${id}`, { priority: Math.round(n) });
  };

  const refresh = async () => {
    setRefreshing(true);
    await api.post(`/api/subscriptions/${id}/refresh`);
    setRefreshing(false);
  };

  const relogin = async () => {
    await api.post(`/api/subscriptions/${id}/login`);
  };

  return (
    <article className={sub.enabled ? 'card sub-full' : 'card sub-full disabled'}>
      <div className="sub-full-head">
        <div className="sub-ident">
          {editing ? (
            <form onSubmit={saveLabel} className="inline-edit">
              <input
                className="input input-sm"
                value={label}
                autoFocus
                onChange={(e) => setLabel(e.target.value)}
                onBlur={() => void saveLabel()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setLabel(sub.label);
                    setEditing(false);
                  }
                }}
                aria-label="Subscription label"
                maxLength={60}
              />
            </form>
          ) : (
            <button type="button" className="label-btn" onClick={() => setEditing(true)} title="Rename">
              <span className="card-title">{sub.label}</span>
              <span className="dim small">rename</span>
            </button>
          )}
          <div className="sub-badges">
            <Badge tone="neutral" title={sub.rateTier ?? undefined}>
              {planLabel(sub)}
            </Badge>
            {sub.kind === 'default' && <Badge tone="muted">~/.claude</Badge>}
            <Badge tone={sub.status === 'ready' ? 'ok' : sub.status === 'error' ? 'crit' : 'warn'}>{subStatusLabel(sub.status)}</Badge>
            {sub.accountMismatch && (
              <Badge tone="crit" title={`Its token is for ${sub.accountEmail}. Nothing is started on it while that is true.`}>
                wrong account
              </Badge>
            )}
            <StaleBadge usage={u} now={now} />
            {sub.liveRuns > 0 && <Badge tone="accent">{sub.liveRuns} live</Badge>}
          </div>
          <div className="sub-account">
            {/* The account it is signed into is the one whose usage these bars are, so that is the
                one on the face of the card; what it is meant to be only shows when they differ. */}
            {sub.accountEmail ?? sub.email ?? <span className="dim">no account yet</span>}
            {sub.accountMismatch && <span className="dim"> · for {sub.email}</span>}
            {sub.displayName && sub.displayName !== (sub.accountEmail ?? sub.email) && <span className="dim"> · {sub.displayName}</span>}
          </div>
        </div>
        <div className="sub-controls">
          <label className="inline-field">
            <span className="small dim">Enabled</span>
            <Toggle
              checked={sub.enabled}
              label={`${sub.enabled ? 'Disable' : 'Enable'} ${sub.label}`}
              onChange={(v) => void api.patch(`/api/subscriptions/${id}`, { enabled: v })}
            />
          </label>
          <label className="inline-field">
            <span className="small dim">Priority</span>
            <input
              type="number"
              className="input input-sm input-num"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              onBlur={() => void savePriority()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              aria-label="Priority (lower is preferred)"
              title="Lower is preferred when choosing a subscription"
            />
          </label>
        </div>
      </div>

      {sub.login ? (
        <LoginPanel sub={sub} />
      ) : (
        sub.status === 'pending_login' && (
          <div className="callout callout-warn">
            Not signed in yet.{' '}
            <button type="button" className="link-btn" onClick={() => void relogin()}>
              Sign in
            </button>
          </div>
        )
      )}
      {sub.accountMismatch && (
        <div className="callout callout-crit">
          This subscription is for <strong>{sub.email}</strong>, but the token in its profile belongs to{' '}
          <strong>{sub.accountEmail}</strong>. Every number below is {sub.accountEmail}'s, so nothing is started or
          swapped here until it is put right — log in again with the right account, or rename this subscription to the
          account it is actually on.{' '}
          <button type="button" className="link-btn" onClick={() => void relogin()}>
            Log in again
          </button>
        </div>
      )}
      {(sub.status === 'logged_out' || sub.status === 'error') && (
        <div className="callout callout-crit">
          {sub.lastError ?? (sub.status === 'logged_out' ? 'This profile is logged out.' : 'Something went wrong.')}{' '}
          <button type="button" className="link-btn" onClick={() => void relogin()}>
            Log in again
          </button>
        </div>
      )}

      <div className="sub-usage">
        <UsageBar label="5 hour" window={u?.fiveHour} now={now} />
        <UsageBar label="7 day" window={u?.sevenDay} now={now} />
        {u?.scoped.map((w) => (
          <div
            key={w.label}
            title={`A second weekly ceiling, under the 7-day one rather than part of it. ${w.label} work counts against both; everything else counts only against the 7 day. It stops sessions running ${w.label} and no others.`}
          >
            <UsageBar label={`${w.label} week`} window={w} now={now} />
          </div>
        ))}
        <div className="sub-spark">
          <span className="small dim">5h usage, last 48h</span>
          <Sparkline points={history} width={180} height={34} />
        </div>
      </div>

      <footer className="sub-foot">
        <span className="small dim" title={u ? absTime(u.fetchedAt) : undefined}>
          {u ? `updated ${timeAgo(u.fetchedAt, now)} via ${u.source}` : 'usage not fetched yet'}
          {u?.error && !u.stale ? ` · ${u.error}` : ''}
        </span>
        <span className="mono dim small sub-dir" title={sub.configDir}>
          {sub.configDir}
        </span>
        <span className="row-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void refresh()}
            disabled={refreshing || limited}
            title={
              limited
                ? `Rate limited — polling is paused until ${absTime(u?.retryAt) || 'the endpoint recovers'} (${retryIn(u?.retryAt, now)}). The daemon refuses earlier refreshes.`
                : 'Poll this subscription’s usage now'
            }
          >
            <Icon name="refresh" size={14} />
            <span>{refreshing ? 'Refreshing…' : 'Refresh usage'}</span>
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void relogin()}>
            <Icon name="key" size={14} />
            <span>Re-login</span>
          </button>
          <IconButton icon="trash" label={`Remove ${sub.label}`} variant="danger" onClick={onRemove} />
        </span>
      </footer>
    </article>
  );
}

/**
 * A sign-in the daemon is running for a subscription. claude opens a browser on the desk, and signing
 * in there finishes it. From anywhere else, its link opens here, and the code the page ends on is
 * pasted back.
 */
function LoginPanel({ sub }: { sub: Subscription }) {
  const login = sub.login;
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const id = encodeURIComponent(sub.id);
  useEffect(() => {
    if (login?.status === 'failed' || login?.status === 'done') setCode('');
  }, [login?.status]);
  if (!login) return null;
  const restart = () => void api.post(`/api/subscriptions/${id}/login`);
  const cancel = () => void api.del(`/api/subscriptions/${id}/login`);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setSending(true);
    await api.post(`/api/subscriptions/${id}/login/code`, { code: code.trim() });
    setSending(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(login.url ?? '');
      emitToast('info', 'Sign-in link copied');
    } catch {
      emitToast('error', 'Could not copy; long-press the button to copy the link instead.');
    }
  };
  if (login.status === 'done') return <div className="callout callout-ok">Signed in. Checking which account it is…</div>;
  if (login.status === 'failed') {
    return (
      <div className="callout callout-crit">
        Sign-in did not finish: {login.error ?? 'claude auth login stopped.'}{' '}
        <button type="button" className="link-btn" onClick={restart}>
          Try again
        </button>
      </div>
    );
  }
  if (login.status === 'starting' || !login.url) {
    return <div className="callout callout-warn">Starting <span className="mono">claude auth login</span>…</div>;
  }
  const account = sub.email ? <strong>{sub.email}</strong> : 'the account you want for this subscription';
  return (
    <div className="callout callout-warn login-panel">
      <p>
        A browser opened on the desk to sign in. Not at the desk, or nothing opened? Open the sign-in page here and sign in
        with {account}, then paste the code it shows you.
      </p>
      <div className="login-actions">
        <a className="btn btn-sm btn-primary" href={login.url} target="_blank" rel="noreferrer noopener">
          <Icon name="key" size={14} />
          <span>Open sign-in page</span>
        </a>
        <button type="button" className="btn btn-sm" onClick={() => void copy()}>
          <Icon name="copy" size={14} />
          <span>Copy link</span>
        </button>
        <button type="button" className="link-btn" onClick={cancel}>
          Cancel
        </button>
      </div>
      <form className="login-code" onSubmit={submit}>
        <input
          className="input input-sm mono"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Paste the code here"
          aria-label="Sign-in code"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-sm" disabled={sending || !code.trim() || login.status === 'submitted'}>
          {login.status === 'submitted' ? 'Checking…' : 'Submit code'}
        </button>
      </form>
      <p className="small dim">Signed in with another account already? Use a private window, or the browser picks that one.</p>
    </div>
  );
}

function AddSubscriptionDialog({ open, onClose, subs }: { open: boolean; onClose: () => void; subs: Subscription[] }) {
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Subscription | null>(null);

  useEffect(() => {
    if (open) {
      setLabel('');
      setEmail('');
      setCreated(null);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    const sub = await api.post<Subscription>('/api/subscriptions', { label: label.trim(), ...(email.trim() ? { email: email.trim() } : {}) });
    setBusy(false);
    if (sub) setCreated(sub);
  };

  if (created) {
    const live = subs.find((s) => s.id === created.id) ?? created;
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title="Finish signing in"
        footer={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Got it
          </button>
        }
      >
        <div className="prose">
          <p>
            Sign <strong>{live.label}</strong> in with {live.email ? <strong>{live.email}</strong> : 'the account you want for this subscription'}.
            When it is done, its card switches to “ready” on its own.
          </p>
          {live.login ? (
            <LoginPanel sub={live} />
          ) : live.status === 'ready' ? (
            <div className="callout callout-ok">Signed in.</div>
          ) : (
            <p className="muted">The sign-in stopped. Use “Re-login” on the card to start it again.</p>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add subscription"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-sub-form" className="btn btn-primary" disabled={busy || !label.trim()}>
            {busy ? 'Creating…' : 'Create & open login'}
          </button>
        </>
      }
    >
      <form id="add-sub-form" className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Label</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work Max" maxLength={60} required />
        </label>
        <label className="field">
          <span className="field-label">
            Email <span className="optional">optional</span>
          </span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoCapitalize="off"
          />
          <span className="field-hint">Used as a reminder of which account to sign in with; the real account is read after login.</span>
        </label>
        <p className="field-hint">
          Switchboard creates an isolated profile folder and opens a terminal on the desk for <span className="mono">claude auth login</span>.
        </p>
      </form>
    </Dialog>
  );
}

function RemoveDialog({ sub, onClose }: { sub: Subscription | null; onClose: () => void }) {
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPurge(false), [sub?.id]);

  const confirm = async () => {
    if (!sub) return;
    setBusy(true);
    const ok = await api.del(`/api/subscriptions/${encodeURIComponent(sub.id)}${purge ? '?purge=1' : ''}`);
    setBusy(false);
    if (ok) {
      emitToast('success', `Removed ${sub.label}`);
      onClose();
    }
  };

  return (
    <ConfirmDialog
      open={!!sub}
      title={`Remove ${sub?.label ?? 'subscription'}?`}
      confirmLabel="Remove"
      danger
      busy={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    >
      <p>Switchboard stops using this login. Running sessions on it keep running until they exit or are swapped.</p>
      {sub?.liveRuns ? <p className="warn">{sub.liveRuns} live session(s) are using it right now.</p> : null}
      {sub && sub.kind !== 'default' && (
        <label className="check">
          <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
          <span>
            Also delete the profile folder
            <span className="field-hint mono">{sub.configDir}</span>
          </span>
        </label>
      )}
      {sub?.kind === 'default' && <p className="field-hint">This is your regular ~/.claude login; its folder is never deleted.</p>}
    </ConfirmDialog>
  );
}
