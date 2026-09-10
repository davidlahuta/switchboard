import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type {
  Agent,
  Claim,
  Conflict,
  HumanMessageRequest,
  Message,
  MessageKind,
  Note,
  NoteKind,
  RepoDetail,
  StateSnapshot,
} from '@shared/types.ts';
import { UNREAD_CAP } from '@shared/types.ts';
import { NewSessionDialog } from '../components/NewSessionDialog.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Badge, Empty, Icon, IconButton, Section, Spinner, StatusPill } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { basename, plural } from '../lib/format.ts';
import { href } from '../lib/router.ts';
import { useStore } from '../lib/store.tsx';
import { absTime, clockTime, timeAgo, useNow } from '../lib/time.ts';

type Tab = 'agents' | 'messages' | 'files' | 'notes';

export function RepoDetailPage({ repoId, state }: { repoId: string; state: StateSnapshot }) {
  const { repoDetail, repoDetailId, setOpenRepo } = useStore();
  const now = useNow(5000);
  const [tab, setTab] = useState<Tab>('agents');
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    setOpenRepo(repoId);
    return () => setOpenRepo(null);
  }, [repoId, setOpenRepo]);

  const summary = state.repos.find((r) => r.id === repoId);
  const detail = repoDetail;
  const unread = detail?.repo.unreadForHuman ?? summary?.unreadForHuman ?? 0;

  // Mark messages to the human as read while this page is visible.
  useEffect(() => {
    if (unread <= 0) return;
    const mark = () => {
      if (document.visibilityState === 'visible') void api.post(`/api/repos/${encodeURIComponent(repoId)}/read`);
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [repoId, unread]);

  if (!detail) {
    if (repoDetailId === repoId) {
      return (
        <div className="page">
          <Empty icon="warn">
            Repo not found. <a href={href.overview()}>Back to overview</a>
          </Empty>
        </div>
      );
    }
    return (
      <div className="page">
        <PageHead title={summary?.name ?? 'Repo'} back={{ href: href.overview(), label: 'Overview' }} />
        <div className="center-block">
          <Spinner />
        </div>
      </div>
    );
  }

  const { repo } = detail;
  const openConflicts = detail.conflicts.filter((c) => c.status === 'open');
  const online = detail.agents.filter((a) => a.status !== 'offline');

  const tabs: Array<{ key: Tab; label: string; count?: number; hot?: boolean }> = [
    { key: 'agents', label: 'Agents', count: online.length, hot: openConflicts.length > 0 },
    { key: 'messages', label: 'Messages', count: unread || undefined, hot: unread > 0 },
    { key: 'files', label: 'Files' },
    { key: 'notes', label: 'Notes', count: detail.notes.filter((n) => n.pinned).length || undefined },
  ];

  return (
    <div className="page repo-page">
      <PageHead
        back={{ href: href.overview(), label: 'Overview' }}
        title={repo.name}
        subtitle={
          <span className="mono" title={repo.root}>
            {repo.root}
          </span>
        }
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={16} />
            New session here
          </button>
        }
      />

      <div className="seg-tabs" role="tablist" aria-label="Repo sections">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'seg-tab active' : 'seg-tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count !== undefined && <span className={t.hot ? 'seg-count hot' : 'seg-count'}>{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="repo-grid">
        <div className={tab === 'agents' ? 'repo-panel is-active' : 'repo-panel'} data-panel="agents">
          {openConflicts.length > 0 && <ConflictsSection conflicts={openConflicts} now={now} />}
          <AgentsSection detail={detail} state={state} now={now} />
          <ClaimsSection claims={detail.claims} now={now} />
        </div>
        <div className={tab === 'messages' ? 'repo-panel is-active' : 'repo-panel'} data-panel="messages">
          <MessagesSection detail={detail} now={now} />
        </div>
        <div className={tab === 'files' ? 'repo-panel is-active' : 'repo-panel'} data-panel="files">
          <FilesSection detail={detail} now={now} />
          <FeedSection detail={detail} now={now} />
        </div>
        <div className={tab === 'notes' ? 'repo-panel is-active' : 'repo-panel'} data-panel="notes">
          <NotesSection repoId={repo.id} notes={detail.notes} now={now} />
        </div>
      </div>

      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} state={state} initialCwd={repo.root} />
    </div>
  );
}

// ---------------- agents ----------------

function AgentsSection({ detail, state, now }: { detail: RepoDetail; state: StateSnapshot; now: number }) {
  const subLabel = (id: string | null) => (id ? (state.subscriptions.find((s) => s.id === id)?.label ?? id.slice(0, 8)) : '—');
  const online = detail.agents.filter((a) => a.status !== 'offline');
  const offline = detail.agents.filter((a) => a.status === 'offline');

  return (
    <Section title="Agents" count={online.length}>
      {online.length === 0 ? (
        <Empty icon="bolt">No agents online in this repo.</Empty>
      ) : (
        <AgentTable agents={online} subLabel={subLabel} now={now} />
      )}
      {offline.length > 0 && (
        <details className="collapse">
          <summary>{plural(offline.length, 'offline agent')}</summary>
          <AgentTable agents={offline} subLabel={subLabel} now={now} />
        </details>
      )}
    </Section>
  );
}

function AgentTable({ agents, subLabel, now }: { agents: Agent[]; subLabel: (id: string | null) => string; now: number }) {
  return (
    <div className="table-wrap">
      <table className="rtable">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th>Branch / worktree</th>
            <th>Intent</th>
            <th>Subscription</th>
            <th>Last tool</th>
            <th>Seen</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id} className={a.status === 'offline' ? 'row-muted' : undefined}>
              <td data-label="Agent" className="cell-title">
                <span className="agent-name">
                  {a.name}
                  {a.unread > 0 && (
                    <Badge tone="accent" title="Messages waiting for this agent">
                      {a.unread >= UNREAD_CAP ? `${UNREAD_CAP}+` : a.unread} unread
                    </Badge>
                  )}
                  {a.runId && (
                    <a className="inline-link" href={href.terminal(a.runId)} aria-label={`Open terminal for ${a.name}`} title="Open terminal">
                      <Icon name="terminal" size={14} />
                    </a>
                  )}
                </span>
                <span className="mono dim" title={a.id}>
                  {a.id.slice(0, 8)}
                </span>
              </td>
              <td data-label="Status">
                <StatusPill status={a.status} />
                {!a.hasChannel && a.status !== 'offline' && (
                  <span className="dim small" title="No push channel: messages arrive via hooks or sb_inbox">
                    {' '}
                    no push
                  </span>
                )}
              </td>
              <td data-label="Branch">
                <span className="mono">{a.branch ?? '—'}</span>
                {a.worktree && (
                  <span className="mono dim small" title={a.worktree}>
                    {' '}
                    {basename(a.worktree)}
                  </span>
                )}
              </td>
              <td data-label="Intent" className="cell-wrap">
                {a.intent ?? <span className="dim">—</span>}
              </td>
              <td data-label="Subscription">{subLabel(a.subscriptionId)}</td>
              <td data-label="Last tool">
                <span className="mono">{a.lastTool ?? '—'}</span>
              </td>
              <td data-label="Seen" title={absTime(a.lastSeen)}>
                {timeAgo(a.lastSeen, now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- conflicts & claims ----------------

function ConflictsSection({ conflicts, now }: { conflicts: Conflict[]; now: number }) {
  const act = (c: Conflict, status: 'resolved' | 'dismissed') => void api.post(`/api/conflicts/${c.id}`, { status });
  return (
    <Section title="Open conflicts" count={conflicts.length} className="section-alert">
      <ul className="list">
        {conflicts.map((c) => (
          <li key={c.id} className="list-row conflict-row">
            <Icon name="warn" className="lvl-crit" />
            <span className="list-main">
              <span className="list-title mono">{c.path}</span>
              <span className="list-sub">
                {c.kind === 'claim' ? 'claim violated' : 'overlapping edits'}: <strong>{c.agentAName}</strong> ↔ <strong>{c.agentBName}</strong>
                {c.detail ? ` — ${c.detail}` : ''} · {timeAgo(c.createdAt, now)}
              </span>
            </span>
            <span className="list-badges">
              <button type="button" className="btn btn-sm" onClick={() => act(c, 'resolved')}>
                Resolve
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(c, 'dismissed')}>
                Dismiss
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ClaimsSection({ claims, now }: { claims: Claim[]; now: number }) {
  if (claims.length === 0) return null;
  return (
    <Section title="Claims" count={claims.length}>
      <ul className="list">
        {claims.map((c) => (
          <li key={c.id} className="list-row">
            <span className="list-main">
              <span className="list-title">
                <span className="mono">{c.pattern}</span>{' '}
                {c.exclusive ? <Badge tone="crit">exclusive</Badge> : <Badge tone="neutral">soft</Badge>}
              </span>
              <span className="list-sub">
                {c.agentName}
                {c.reason ? ` — ${c.reason}` : ''} · {timeAgo(c.createdAt, now)}
                {c.expiresAt ? ` · expires ${clockTime(c.expiresAt)}` : ''}
              </span>
            </span>
            <button type="button" className="btn btn-sm" onClick={() => void api.del(`/api/claims/${c.id}`)}>
              Release
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------- messages ----------------

const MESSAGE_KINDS: MessageKind[] = ['info', 'question', 'request', 'handoff', 'warning'];

function MessagesSection({ detail, now }: { detail: RepoDetail; now: number }) {
  const [to, setTo] = useState<string>('');
  const [kind, setKind] = useState<MessageKind>('info');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  const messages = useMemo(
    () => [...detail.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
    [detail.messages],
  );
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const agents = [...detail.agents].sort((a, b) => Number(a.status === 'offline') - Number(b.status === 'offline') || a.name.localeCompare(b.name));

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    const req: HumanMessageRequest = { to: to || null, body: text, kind };
    const res = await api.post<Message>(`/api/repos/${encodeURIComponent(detail.repo.id)}/messages`, req);
    setBusy(false);
    if (res) {
      setBody('');
      stick.current = true;
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const replyTo = (m: Message) => {
    if (m.from !== 'human' && m.from !== 'switchboard') setTo(m.from);
    if (m.kind === 'question' || m.kind === 'request') setKind('info');
    inputRef.current?.focus();
  };

  return (
    <Section title="Messages" count={messages.length}>
      <div
        className="thread"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0 && <Empty icon="message">No messages yet.</Empty>}
        {messages.map((m) => {
          const mine = m.from === 'human';
          const forMe = m.to === 'human';
          const parent = m.replyTo ? byId.get(m.replyTo) : undefined;
          return (
            <article
              key={m.id}
              className={['msg', mine ? 'msg-mine' : '', forMe ? 'msg-for-me' : '', m.from === 'switchboard' ? 'msg-system' : '', `msg-${m.kind}`]
                .filter(Boolean)
                .join(' ')}
            >
              <header className="msg-head">
                <strong>{mine ? 'You' : m.fromName}</strong>
                <span className="dim"> → {m.to === null ? 'everyone' : forMe ? 'you' : m.toName}</span>
                {m.kind !== 'info' && <Badge tone={m.kind === 'warning' || m.kind === 'conflict' ? 'warn' : 'accent'}>{m.kind}</Badge>}
                {m.urgent && <Badge tone="crit">urgent</Badge>}
                <time className="msg-time" dateTime={m.createdAt} title={absTime(m.createdAt)}>
                  {timeAgo(m.createdAt, now)}
                </time>
              </header>
              {parent && (
                <div className="msg-quote">
                  ↪ {parent.from === 'human' ? 'You' : parent.fromName}: {parent.body.slice(0, 120)}
                </div>
              )}
              <div className="msg-body">{m.body}</div>
              <footer className="msg-foot">
                <span className="dim small">{m.deliveredCount > 0 ? `delivered to ${m.deliveredCount}` : 'not delivered yet'}</span>
                {!mine && m.from !== 'switchboard' && (
                  <button type="button" className="link-btn small" onClick={() => replyTo(m)}>
                    Reply
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>

      <form className="composer" onSubmit={send}>
        <div className="composer-opts">
          <label className="sr-only" htmlFor="msg-to">
            Recipient
          </label>
          <select id="msg-to" className="input input-sm" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Broadcast (all agents)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status === 'offline' ? ' (offline)' : ''}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="msg-kind">
            Kind
          </label>
          <select id="msg-kind" className="input input-sm" value={kind} onChange={(e) => setKind(e.target.value as MessageKind)}>
            {MESSAGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="composer-row">
          <textarea
            ref={inputRef}
            className="input composer-input"
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKey}
            placeholder={to ? 'Message this agent… (Ctrl+Enter to send)' : 'Message every agent in this repo…'}
            aria-label="Message"
          />
          <button type="submit" className="btn btn-primary btn-send" disabled={busy || !body.trim()} aria-label="Send message">
            <Icon name="send" size={16} />
          </button>
        </div>
      </form>
    </Section>
  );
}

// ---------------- files & feed ----------------

interface FileGroup {
  path: string;
  agents: Array<{ name: string; count: number; worktree: string | null }>;
  count: number;
  lastTs: string;
}

function FilesSection({ detail, now }: { detail: RepoDetail; now: number }) {
  const groups = useMemo(() => {
    const m = new Map<string, FileGroup>();
    for (const f of detail.files) {
      let g = m.get(f.path);
      if (!g) {
        g = { path: f.path, agents: [], count: 0, lastTs: f.lastTs };
        m.set(f.path, g);
      }
      g.agents.push({ name: f.agentName, count: f.count, worktree: f.worktree });
      g.count += f.count;
      if (f.lastTs > g.lastTs) g.lastTs = f.lastTs;
    }
    return [...m.values()].sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }, [detail.files]);
  const shared = groups.filter((g) => new Set(g.agents.map((a) => a.name)).size > 1).length;

  return (
    <Section title="Recent file activity" count={groups.length}>
      {shared > 0 && <p className="hint warn">{plural(shared, 'file')} touched by more than one agent.</p>}
      {groups.length === 0 ? (
        <Empty icon="file">No edits recorded yet.</Empty>
      ) : (
        <ul className="list files">
          {groups.map((g) => {
            const multi = new Set(g.agents.map((a) => a.name)).size > 1;
            return (
              <li key={g.path} className={multi ? 'list-row file-row multi' : 'list-row file-row'}>
                <span className="list-main">
                  <span className="list-title mono file-path" title={g.path}>
                    {g.path}
                  </span>
                  <span className="list-sub">
                    {g.agents.map((a, i) => (
                      <span key={a.name + i} title={a.worktree ?? undefined}>
                        {i > 0 && ', '}
                        {a.name}
                        <span className="dim"> ×{a.count}</span>
                      </span>
                    ))}
                  </span>
                </span>
                <span className="list-time" title={absTime(g.lastTs)}>
                  {timeAgo(g.lastTs, now)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function FeedSection({ detail, now }: { detail: RepoDetail; now: number }) {
  const events = useMemo(() => [...detail.events].sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id).slice(0, 100), [detail.events]);
  return (
    <Section title="Activity">
      {events.length === 0 ? (
        <Empty>No activity yet.</Empty>
      ) : (
        <ol className="feed">
          {events.map((e) => (
            <li key={e.id} className={`feed-item feed-${e.type.replace(/[^a-z0-9_-]/gi, '')}`}>
              <time className="feed-time" dateTime={e.ts} title={absTime(e.ts)}>
                {timeAgo(e.ts, now)}
              </time>
              <span className="feed-text">
                {e.agentName && <strong>{e.agentName} </strong>}
                {e.summary}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

// ---------------- notes ----------------

const NOTE_KINDS: NoteKind[] = ['decision', 'fact', 'warning', 'todo'];

function NotesSection({ repoId, notes, now }: { repoId: string; notes: Note[]; now: number }) {
  const [kind, setKind] = useState<NoteKind>('fact');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);

  const pinnedNotes = notes.filter((n) => n.pinned);
  const other = notes.filter((n) => !n.pinned);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    const res = await api.post<Note>(`/api/repos/${encodeURIComponent(repoId)}/notes`, { kind, body: body.trim(), pinned });
    setBusy(false);
    if (res) {
      setBody('');
      setPinned(false);
    }
  };

  const noteList = (list: Note[]) => (
    <ul className="notes">
      {list.map((n) => (
        <li key={n.id} className={`note note-${n.kind}`}>
          <div className="note-head">
            <Badge tone={n.kind === 'warning' ? 'warn' : n.kind === 'decision' ? 'accent' : n.kind === 'todo' ? 'ok' : 'neutral'}>{n.kind}</Badge>
            <span className="dim small">
              {n.agentName} · {timeAgo(n.createdAt, now)}
            </span>
            <span className="note-actions">
              <IconButton
                icon="pin"
                label={n.pinned ? 'Unpin note' : 'Pin note'}
                className={n.pinned ? 'is-on' : undefined}
                onClick={() => void api.patch(`/api/notes/${n.id}`, { pinned: !n.pinned })}
              />
              <IconButton icon="archive" label="Archive note" onClick={() => void api.patch(`/api/notes/${n.id}`, { archived: true })} />
            </span>
          </div>
          <div className="note-body">{n.body}</div>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <Section title="Pinned notes" count={pinnedNotes.length}>
        {pinnedNotes.length === 0 ? <Empty icon="pin">Nothing pinned. Pinned notes are shown to every agent at session start.</Empty> : noteList(pinnedNotes)}
      </Section>

      <Section title="Add note">
        <form className="form note-form" onSubmit={add}>
          <div className="field-row">
            <label className="field field-narrow">
              <span className="field-label">Kind</span>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as NoteKind)}>
                {NOTE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="check check-inline">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <span>Pin</span>
            </label>
          </div>
          <label className="field">
            <span className="sr-only">Note</span>
            <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="We decided to…" />
          </label>
          <div>
            <button type="submit" className="btn btn-primary" disabled={busy || !body.trim()}>
              Add note
            </button>
          </div>
        </form>
      </Section>

      <Section title="Other notes" count={other.length}>
        {other.length === 0 ? <Empty>No other notes.</Empty> : noteList(other)}
      </Section>
    </>
  );
}
