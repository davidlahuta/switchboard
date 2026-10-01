import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Desk, DeskPairing, DeskRepo } from '@shared/desk.ts';
import type { StateSnapshot } from '@shared/types.ts';
import { PageHead } from '../components/PageHead.tsx';
import { CredentialsSection } from '../components/CredentialsSection.tsx';
import { Badge, ConfirmDialog, Dialog, Empty, Icon, IconButton, Section, Toggle } from '../components/ui.tsx';
import { api, request } from '../lib/api.ts';
import { countdown, timeAgo, useNow } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';

/**
 * The hub and the satellite desks that host sessions for it: how much each should take, what it can
 * do, which repositories it holds, and adding or removing one.
 */
export function DesksPage({ state }: { state: StateSnapshot }) {
  const now = useNow(1000);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Desk | null>(null);
  const desks = state.desks;

  return (
    <div className="page">
      <PageHead
        title="Desks"
        subtitle="Machines that host sessions for this hub. A new session goes to a desk under its recommended maximum, preferring one that already has the repository; a desk goes over its maximum only when every desk that could take the session is full."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
            Add a desk
          </button>
        }
      />

      <div className="sub-list">
        {desks.map((d) => (
          <DeskCard key={d.id} desk={d} now={now} onRemove={() => setRemoving(d)} />
        ))}
      </div>

      <RepoMatrix desks={desks} />

      <CredentialsSection />

      <AddDeskDialog open={adding} onClose={() => setAdding(false)} now={now} />
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? 'desk'}?`}
        confirmLabel="Remove desk"
        danger
        onConfirm={() => {
          const d = removing;
          setRemoving(null);
          if (d) void api.del(`/api/desks/${encodeURIComponent(d.id)}`).then((r) => r && emitToast('info', `${d.name} removed. Its token no longer works.`));
        }}
        onCancel={() => setRemoving(null)}
      >
        <p>
          Its token stops working at once and its agent is disconnected. Nothing on that machine is deleted: its clones, and any
          conversations there, stay where they are. To bring it back, pair it again.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function DeskCard({ desk: d, now, onRemove }: { desk: Desk; now: number; onRemove: () => void }) {
  const id = encodeURIComponent(d.id);
  const [name, setName] = useState(d.name);
  const [editing, setEditing] = useState(false);
  const [max, setMax] = useState(String(d.recommendedMaxSessions));
  const [cloneRoot, setCloneRoot] = useState(d.cloneRoot ?? '');
  const [roots, setRoots] = useState(d.repoRoots.join('\n'));
  const [scanning, setScanning] = useState(false);

  useEffect(() => setMax(String(d.recommendedMaxSessions)), [d.recommendedMaxSessions]);
  useEffect(() => setCloneRoot(d.cloneRoot ?? ''), [d.cloneRoot]);
  useEffect(() => setRoots(d.repoRoots.join('\n')), [d.repoRoots.join('\n')]);
  useEffect(() => {
    if (!editing) setName(d.name);
  }, [d.name, editing]);

  const patch = (body: Record<string, unknown>) => api.patch(`/api/desks/${id}`, body);
  const saveName = (e?: FormEvent) => {
    e?.preventDefault();
    setEditing(false);
    if (name.trim() && name.trim() !== d.name) void patch({ name: name.trim() });
    else setName(d.name);
  };
  const saveMax = () => {
    const n = Number(max);
    if (!Number.isFinite(n) || n === d.recommendedMaxSessions) return setMax(String(d.recommendedMaxSessions));
    void patch({ recommendedMaxSessions: Math.round(n) });
  };
  const scan = async () => {
    setScanning(true);
    await api.post(`/api/desks/${id}/scan`);
    setScanning(false);
  };
  const full = d.liveRuns >= d.recommendedMaxSessions;
  const t = d.tools;

  return (
    <article className={d.enabled ? 'card sub-full' : 'card sub-full disabled'}>
      <div className="sub-full-head">
        <div className="sub-ident">
          {editing ? (
            <form onSubmit={saveName} className="inline-edit">
              <input
                className="input input-sm"
                value={name}
                autoFocus
                maxLength={60}
                aria-label="Desk name"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => saveName()}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setName(d.name);
                    setEditing(false);
                  }
                }}
              />
            </form>
          ) : (
            <button type="button" className="label-btn" onClick={() => setEditing(true)} title="Rename">
              <span className="card-title">{d.name}</span>
              <span className="dim small">rename</span>
            </button>
          )}
          <div className="sub-badges">
            <Badge tone={d.hub ? 'accent' : 'neutral'}>{d.hub ? 'hub' : 'satellite'}</Badge>
            <Badge tone={d.online ? 'ok' : 'crit'}>{d.online ? 'online' : 'offline'}</Badge>
            <Badge tone={full ? 'warn' : 'muted'} title="Live sessions against its recommended maximum">
              {d.liveRuns}/{d.recommendedMaxSessions} sessions
            </Badge>
            {d.platform && <Badge tone="muted">{platformLabel(d.platform)}</Badge>}
          </div>
          <div className="sub-account">
            {d.user ?? '?'}@{d.hostname ?? '?'}
            {d.cores ? <span className="dim"> · {d.cores} cores, {d.memGb} GB</span> : null}
            {!d.hub && d.version ? <span className="dim"> · switchboard {d.version}</span> : null}
            {!d.hub && !d.online && d.lastSeen ? <span className="dim"> · last seen {timeAgo(d.lastSeen, now)}</span> : null}
          </div>
        </div>
        <div className="sub-controls">
          <label className="inline-field">
            <span className="small dim">Takes sessions</span>
            <Toggle checked={d.enabled} label={`${d.enabled ? 'Stop placing sessions on' : 'Place sessions on'} ${d.name}`} onChange={(v) => void patch({ enabled: v })} />
          </label>
          <label className="inline-field" title="How many sessions placement puts here before it looks elsewhere. 0 makes it take only overflow.">
            <span className="small dim">Recommended max</span>
            <input
              type="number"
              min={0}
              max={200}
              className="input input-sm input-num"
              value={max}
              aria-label="Recommended maximum sessions"
              onChange={(e) => setMax(e.target.value)}
              onBlur={saveMax}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </label>
          {!d.maxIsDefault && (
            <button type="button" className="link-btn small" onClick={() => void patch({ recommendedMaxSessions: null })} title="Go back to the guess from its cores and memory">
              auto
            </button>
          )}
        </div>
      </div>

      {!d.hub && !d.online && (
        <div className="callout callout-warn">
          This desk's agent is not connected. Its sessions keep running there, but nothing new is placed on it and nothing there is
          brought back until it reconnects. On that machine: <span className="mono">node src/cli.ts desk status</span>.
        </div>
      )}

      <div className="desk-tools">
        <Tool label="claude" ok={!!t?.claude} value={t?.claudeVersion || (t?.claude ? 'found' : 'missing')} />
        <Tool label="git" ok={!!t?.git} value={t?.git || 'missing'} />
        <Tool label="gh" ok={!!t?.gh.account} value={t?.gh.account ?? (t?.gh.installed ? 'not logged in' : 'not installed')} />
        <Tool label="az" ok={!!t?.az.account} value={t?.az.account ?? (t?.az.installed ? 'not logged in' : 'not installed')} />
        {d.platform === 'win32' && <Tool label="terminal" ok={!!t?.wt} value={t?.wt ? 'Windows Terminal' : 'console'} />}
        <Tool label="node" ok value={t?.node ?? '?'} />
      </div>

      <div className="field-row">
        <label className="field">
          <span className="field-label">Clone root</span>
          <input
            className="input input-sm mono"
            value={cloneRoot}
            placeholder={d.hub ? 'the source/repos folder in your home' : 'the agent default: source/repos in its home'}
            onChange={(e) => setCloneRoot(e.target.value)}
            onBlur={() => cloneRoot !== (d.cloneRoot ?? '') && void patch({ cloneRoot: cloneRoot.trim() || null })}
          />
          <span className="field-hint">Where a repository is cloned when a session is placed here and it has none. A path on that machine.</span>
        </label>
        {!d.hub && (
          <label className="field">
            <span className="field-label">Repository roots</span>
            <textarea
              className="input input-sm mono"
              rows={2}
              value={roots}
              onChange={(e) => setRoots(e.target.value)}
              onBlur={() => roots !== d.repoRoots.join('\n') && void patch({ repoRoots: roots.split('\n').map((x) => x.trim()).filter(Boolean) })}
            />
            <span className="field-hint">Folders scanned there for clones, one per line.</span>
          </label>
        )}
      </div>

      <footer className="sub-foot">
        <span className="small dim">
          {d.repos.length} {d.repos.length === 1 ? 'repository' : 'repositories'}
          {d.hub ? ' · roots are set under Settings → Repositories' : ''}
        </span>
        <span className="row-actions">
          <button type="button" className="btn btn-sm" onClick={() => void scan()} disabled={scanning || !d.online}>
            <Icon name="refresh" size={14} />
            <span>{scanning ? 'Scanning…' : 'Rescan'}</span>
          </button>
          {!d.hub && <IconButton icon="trash" label={`Remove ${d.name}`} variant="danger" onClick={onRemove} />}
        </span>
      </footer>
    </article>
  );
}

function Tool({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <span className={ok ? 'desk-tool' : 'desk-tool desk-tool-off'} title={`${label}: ${value}`}>
      <span className="desk-tool-label">{label}</span>
      <span className="mono">{value}</span>
    </span>
  );
}

function platformLabel(p: string): string {
  return p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p === 'darwin' ? 'macOS' : p;
}

/**
 * Which desk has which repository, by origin. A missing clone can be made from here, and a
 * repository can be kept to some desks; placement clones anywhere it is allowed.
 */
function RepoMatrix({ desks }: { desks: Desk[] }) {
  const [policies, setPolicies] = useState<Array<{ remoteKey: string; allowedDesks: string[] | null }>>([]);
  const [cloning, setCloning] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void request<typeof policies>('GET', '/api/repo-policy').then(setPolicies, () => setPolicies([]));
  }, []);

  const rows = useMemo(() => {
    const byKey = new Map<string, { key: string; name: string; url: string | null; on: Map<string, DeskRepo> }>();
    for (const d of desks) {
      for (const r of d.repos) {
        if (!r.remoteKey) continue;
        const row = byKey.get(r.remoteKey) ?? { key: r.remoteKey, name: r.remoteKey.split('/').slice(-1)[0], url: r.remoteUrl, on: new Map() };
        row.url ??= r.remoteUrl;
        row.on.set(d.id, r);
        byKey.set(r.remoteKey, row);
      }
    }
    const f = filter.trim().toLowerCase();
    return [...byKey.values()].filter((r) => !f || r.key.includes(f)).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }, [desks, filter]);

  const allowedOf = (key: string): string[] | null => policies.find((p) => p.remoteKey === key)?.allowedDesks ?? null;
  const setAllowed = async (key: string, deskId: string, on: boolean) => {
    const current = allowedOf(key) ?? desks.map((d) => d.id);
    const next = on ? [...new Set([...current, deskId])] : current.filter((x) => x !== deskId);
    const all = desks.every((d) => next.includes(d.id));
    const res = await api.post<typeof policies>('/api/repo-policy', { remoteKey: key, allowedDesks: all ? null : next });
    if (res) setPolicies(res);
  };
  const clone = async (deskId: string, url: string, key: string) => {
    setCloning(`${deskId}|${key}`);
    const res = await api.post<DeskRepo>(`/api/desks/${encodeURIComponent(deskId)}/clone`, { url });
    setCloning(null);
    if (res) emitToast('success', `Cloned ${key} to ${res.path}`);
  };

  if (desks.length < 2) {
    return (
      <Section title="Repositories across desks">
        <Empty icon="repo">Add a desk to see which repositories each one holds.</Empty>
      </Section>
    );
  }

  return (
    <Section
      title="Repositories across desks"
      count={rows.length}
      actions={<input className="input input-sm" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter repositories" />}
    >
      <p className="hint">
        A repository is its origin, so a clone of it on each desk is the same repository and shares one board. The box under each desk
        says whether sessions for it may go there; a desk that may and has no clone gets one when a session is placed on it.
      </p>
      <div className="table-wrap">
        <table className="rtable">
          <thead>
            <tr>
              <th>Repository</th>
              {desks.map((d) => (
                <th key={d.id}>{d.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const allowed = allowedOf(r.key);
              return (
                <tr key={r.key}>
                  <td>
                    <div>{r.name}</div>
                    <div className="mono dim small">{r.key}</div>
                  </td>
                  {desks.map((d) => {
                    const has = r.on.get(d.id);
                    const ok = allowed === null || allowed.includes(d.id);
                    return (
                      <td key={d.id} className="matrix-cell">
                        <label className="matrix-allow" title={ok ? 'Sessions for it may go here' : 'Kept off this desk'}>
                          <input type="checkbox" checked={ok} onChange={(e) => void setAllowed(r.key, d.id, e.target.checked)} />
                        </label>
                        {has ? (
                          <span className="small" title={has.path}>
                            <Icon name="check" size={13} /> {has.branch ?? 'cloned'}
                          </span>
                        ) : ok && r.url && d.online ? (
                          <button type="button" className="btn btn-sm" disabled={cloning === `${d.id}|${r.key}`} onClick={() => void clone(d.id, r.url!, r.key)}>
                            {cloning === `${d.id}|${r.key}` ? 'Cloning…' : 'Clone'}
                          </button>
                        ) : (
                          <span className="dim small">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** A one-time code for a new desk, and exactly what to run there. */
function AddDeskDialog({ open, onClose, now }: { open: boolean; onClose: () => void; now: number }) {
  const [hubUrl, setHubUrl] = useState('');
  const [pairing, setPairing] = useState<DeskPairing | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPairing(null);
    void request<{ detected: string | null; fromRequest: string }>('GET', '/api/desks/hub-url').then(
      (r) => setHubUrl(r.detected ?? r.fromRequest),
      () => setHubUrl(location.origin),
    );
  }, [open]);

  const create = async () => {
    setBusy(true);
    const p = await api.post<DeskPairing>('/api/desks/pairing', { hubUrl: hubUrl.trim() });
    setBusy(false);
    if (p) setPairing(p);
  };
  const local = /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(hubUrl);
  const join = pairing ? `node src/cli.ts desk join ${hubUrl.trim()} ${pairing.code}` : '';

  return (
    <Dialog open={open} onClose={onClose} title="Add a desk" wide footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="form">
        <label className="field">
          <span className="field-label">This hub's address, as the new desk will reach it</span>
          <input className="input mono" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} />
          {local ? (
            <span className="field-hint warn">127.0.0.1 is only this machine. Use the tailnet address (https://&lt;name&gt;.&lt;tailnet&gt;.ts.net, from tailscale serve).</span>
          ) : (
            <span className="field-hint">The desk keeps one connection to this address; sessions there are relayed over it.</span>
          )}
        </label>
        {!pairing ? (
          <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={busy || !hubUrl.trim()}>
            {busy ? 'Creating…' : 'Create a pairing code'}
          </button>
        ) : (
          <>
            <div className="callout">
              Code <span className="mono">{pairing.code}</span>, valid for {countdown(pairing.expiresAt, now)}. Single use.
            </div>
            <ol className="steps">
              <li>
                On the new machine, have <b>Node.js 24+</b>, <b>git</b>, <b>Claude Code</b> (<span className="mono">claude</span> on PATH) and <b>Tailscale</b>{' '}
                on this tailnet. It needs no Claude login of its own: sessions there use this hub's subscriptions. On Linux, also <b>tmux</b>.
              </li>
              <li>
                Get Switchboard:
                <Copyable text="git clone https://github.com/davidlahuta/switchboard && cd switchboard && npm ci" />
              </li>
              <li>
                Join this hub:
                <Copyable text={join} />
              </li>
              <li>
                Keep its agent running — at every logon on Windows, at boot on Linux (it enables lingering):
                <Copyable text="node src/cli.ts service install --desk" />
              </li>
            </ol>
            <p className="hint">It appears in this list as soon as its agent connects.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Copyable({ text }: { text: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      emitToast('info', 'Copied');
    } catch {
      emitToast('error', 'Could not copy; select the text instead.');
    }
  };
  return (
    <div className="copyable">
      <code className="mono">{text}</code>
      <IconButton icon="copy" label="Copy" onClick={() => void copy()} />
    </div>
  );
}
