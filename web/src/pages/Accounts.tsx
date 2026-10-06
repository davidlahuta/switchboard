import { useEffect, useState, type FormEvent } from 'react';
import { type Account, type AccountApp, type AccountsSnapshot, type Provider, adminConsentUrl } from '@shared/accounts.ts';
import type { StateSnapshot } from '@shared/types.ts';
import { PageHead } from '../components/PageHead.tsx';
import { Badge, ConfirmDialog, Dialog, Empty, Icon, IconButton, Section } from '../components/ui.tsx';
import { api, request } from '../lib/api.ts';
import { timeAgo, useNow } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';
import { Copyable } from './Desks.tsx';

interface McpStatus {
  playwright: { version: string | null; error: string | null };
  ms365: { version: string | null; error: string | null };
  google: { running: boolean; port: number; version: string; error: string | null; uv: boolean | null };
}

type AccountsResponse = AccountsSnapshot & { apps: AccountApp[]; mcp: McpStatus };

const NAME: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft' };

/**
 * Google and Microsoft accounts sessions can use, and the two apps they are reached through. Until an
 * app is set up its provider is not offered anywhere; Switchboard works the same without either.
 */
export function AccountsPage({ state }: { state: StateSnapshot }) {
  const now = useNow(30_000);
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [adding, setAdding] = useState<Provider | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const version = JSON.stringify(state.accounts ?? null);

  const load = async () => setData(await api.get<AccountsResponse>('/api/accounts'));
  useEffect(() => {
    void load();
  }, [version]);

  // Back from Google or Microsoft: say how it went, once, and tidy the address.
  useEffect(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const added = q.get('added');
    const error = q.get('error');
    if (added) emitToast('info', `Account ${added} is ready. Pick it when you start a session.`);
    if (error) emitToast('error', error);
    if (added || error) history.replaceState(null, '', '#/accounts');
  }, []);

  const apps = data?.apps ?? [];
  const accounts = data?.accounts ?? [];
  const anyApp = apps.some((a) => a.configured);

  return (
    <div className="page">
      <PageHead
        title="Accounts"
        subtitle="Google and Microsoft accounts your sessions can use: Gmail, Drive, Docs, Calendar, Outlook, OneDrive, Teams. Each session gets only the accounts you pick when you start it, and never sees a password or refresh token — only short-lived access tokens, handed to its MCP servers."
        actions={
          <>
            {data?.enabled.google && (
              <button type="button" className="btn btn-primary" onClick={() => void signIn('google')}>
                <Icon name="plus" size={16} /> Add Google account
              </button>
            )}
            {data?.enabled.microsoft && (
              <button type="button" className="btn btn-primary" onClick={() => setAdding('microsoft')}>
                <Icon name="plus" size={16} /> Add Microsoft account
              </button>
            )}
          </>
        }
      />

      <Section title="Accounts" count={accounts.length}>
        {!data ? null : accounts.length === 0 ? (
          <Empty icon="card">{anyApp ? 'No accounts yet. Add one with the buttons above.' : 'Set up the Google or Microsoft app below first.'}</Empty>
        ) : (
          <div className="account-list">
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} apps={apps} now={now} onRemove={() => setRemoving(a)} onChanged={() => void load()} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Apps">
        <p className="dim small">
          Your own OAuth apps, registered once and never sent for review (see the README, "Google and Microsoft accounts"). Saved here on the desk only; the
          Google client secret is sealed and never leaves this machine.
        </p>
        <div className="app-cards">
          {apps.map((a) => (
            <AppCard key={a.provider} app={a} onSaved={() => void load()} />
          ))}
        </div>
      </Section>

      {data && <McpSection mcp={data.mcp} />}

      <MicrosoftKindDialog provider={adding} onClose={() => setAdding(null)} />
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.email}?`}
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await api.del(`/api/accounts/${encodeURIComponent(removing.id)}`);
          setRemoving(null);
          void load();
        }}
      >
        Sessions that have it lose it the next time they start. Its refresh token is deleted
        {removing?.provider === 'google' ? ' and revoked at Google.' : '; also remove Switchboard under "Apps" in your Microsoft account to revoke it there.'}
      </ConfirmDialog>
    </div>
  );
}

async function signIn(provider: Provider, opts: { kind?: 'personal' | 'work'; accountId?: string } = {}): Promise<void> {
  const r = await api.post<{ url: string }>('/api/accounts/oauth/start', { provider, ...opts });
  if (r?.url) location.href = r.url;
}

function AccountRow({ account: a, apps, now, onRemove, onChanged }: { account: Account; apps: AccountApp[]; now: number; onRemove: () => void; onChanged: () => void }) {
  const [testing, setTesting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [id, setId] = useState(a.id);
  const msApp = apps.find((x) => x.provider === 'microsoft');
  const test = async () => {
    setTesting(true);
    const r = await api.post<{ ok: boolean; detail: string }>(`/api/accounts/${encodeURIComponent(a.id)}/test`);
    setTesting(false);
    if (r) emitToast(r.ok ? 'info' : 'error', `${a.email}: ${r.detail}`);
    onChanged();
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    setRenaming(false);
    if (id.trim() && id.trim() !== a.id) await api.patch(`/api/accounts/${encodeURIComponent(a.id)}`, { id: id.trim() });
    onChanged();
  };
  const kind = a.kind === 'gmail' ? 'Gmail' : a.kind === 'workspace' ? 'Workspace' : a.kind === 'personal' ? 'personal' : 'work';
  return (
    <article className="card account-row">
      <div className="account-main">
        <div className="account-title">
          <span className="card-title">{a.email}</span>
          <Badge tone="accent">{NAME[a.provider]}</Badge>
          <Badge tone="muted">{kind}</Badge>
          <Badge tone={a.status === 'ok' ? 'ok' : 'warn'} title={a.lastError ?? undefined}>
            {a.status === 'ok' ? 'ok' : a.status === 'needs-reconsent' ? 'reconnect' : 'error'}
          </Badge>
        </div>
        <div className="small dim">
          {renaming ? (
            <form onSubmit={(e) => void rename(e)} className="inline-form">
              <input className="input input-sm mono" value={id} onChange={(e) => setId(e.target.value)} autoFocus onBlur={(e) => void rename(e)} aria-label="Account id" />
            </form>
          ) : (
            <button type="button" className="link-btn small" onClick={() => setRenaming(true)} title="The name sessions see this account under. Rename">
              <span className="mono">{a.server}</span>
            </button>
          )}
          {a.displayName ? ` · ${a.displayName}` : ''}
          {' · '}
          {a.lastUsedAt ? `last used ${timeAgo(a.lastUsedAt, now)}` : 'not used yet'}
          {a.mints24h ? ` · ${a.mints24h} token${a.mints24h === 1 ? '' : 's'} today` : ''}
        </div>
        {a.status !== 'ok' && a.lastError && <div className="small warn-text">{a.lastError}</div>}
        {a.provider === 'microsoft' && a.kind === 'work' && a.tenant && msApp?.clientId && (
          <div className="small dim">
            If sign-in or a tool says admin approval is needed, an admin of that organisation consents once:{' '}
            <a href={adminConsentUrl(a.tenant, msApp.clientId)} target="_blank" rel="noreferrer">
              admin consent
            </a>
          </div>
        )}
      </div>
      <div className="account-actions">
        <button type="button" className="btn btn-sm" onClick={() => void test()} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void signIn(a.provider, { accountId: a.id })}>
          Reconnect
        </button>
        <IconButton icon="trash" label={`Remove ${a.email}`} onClick={onRemove} />
      </div>
    </article>
  );
}

function AppCard({ app, onSaved }: { app: AccountApp; onSaved: () => void }) {
  const [clientId, setClientId] = useState(app.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [tenant, setTenant] = useState(app.tenant ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setClientId(app.clientId ?? '');
    setTenant(app.tenant ?? '');
  }, [app.clientId, app.tenant]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await request<AccountApp>('PUT', `/api/account-apps/${app.provider}`, {
        clientId: clientId.trim(),
        ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
        ...(app.provider === 'microsoft' ? { tenant: tenant.trim() } : {}),
      });
      setSecret('');
      emitToast('info', `${NAME[app.provider]} app saved.`);
      onSaved();
    } catch (err) {
      emitToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api.del(`/api/account-apps/${app.provider}`);
    onSaved();
  };
  return (
    <form className="card app-card" onSubmit={(e) => void save(e)}>
      <div className="account-title">
        <span className="card-title">{NAME[app.provider]} app</span>
        <Badge tone={app.configured ? 'ok' : 'muted'}>{app.configured ? 'set up' : 'not set up'}</Badge>
      </div>
      <p className="small dim">
        {app.provider === 'google'
          ? 'A "Web application" OAuth client in your own Google Cloud project, consent screen External and published to production (no verification). Adds Gmail, Drive, Docs, Sheets, Slides, Calendar, Contacts and Tasks.'
          : 'A public-client app registration (no secret) for any organisation and personal Microsoft accounts. Adds Outlook mail and calendar, OneDrive, contacts, To Do, OneNote, and Teams and SharePoint for work accounts.'}
      </p>
      <label className="field">
        <span className="field-label">Client ID</span>
        <input
          className="input mono"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={app.provider === 'google' ? '1234-abc.apps.googleusercontent.com' : '00000000-0000-0000-0000-000000000000'}
          spellCheck={false}
        />
      </label>
      {app.provider === 'google' && (
        <label className="field">
          <span className="field-label">Client secret {app.hasSecret && <span className="dim">(stored; leave empty to keep it)</span>}</span>
          <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      )}
      {app.provider === 'microsoft' && (
        <label className="field">
          <span className="field-label">Owning tenant ID <span className="dim">(optional, for reference)</span></span>
          <input className="input mono" value={tenant} onChange={(e) => setTenant(e.target.value)} spellCheck={false} />
        </label>
      )}
      <div className="field">
        <span className="field-label">Redirect URIs to register</span>
        {app.redirectUris.map((u) => (
          <Copyable key={u} text={u} />
        ))}
      </div>
      <div className="app-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !clientId.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {app.configured && (
          <button type="button" className="btn btn-sm" onClick={() => void remove()}>
            Remove app
          </button>
        )}
      </div>
    </form>
  );
}

function MicrosoftKindDialog({ provider, onClose }: { provider: Provider | null; onClose: () => void }) {
  return (
    <Dialog open={provider === 'microsoft'} onClose={onClose} title="Add a Microsoft account">
      <p>Which kind of account?</p>
      <div className="choice-buttons">
        <button type="button" className="btn" onClick={() => void signIn('microsoft', { kind: 'personal' })}>
          Personal
          <span className="field-hint">outlook.com, hotmail.com, live.com</span>
        </button>
        <button type="button" className="btn" onClick={() => void signIn('microsoft', { kind: 'work' })}>
          Work or school
          <span className="field-hint">Microsoft 365: adds Teams and SharePoint</span>
        </button>
      </div>
    </Dialog>
  );
}

function McpSection({ mcp }: { mcp: McpStatus }) {
  const line = (name: string, ok: boolean, text: string, error: string | null) => (
    <li>
      <Badge tone={ok ? 'ok' : error ? 'warn' : 'muted'}>{name}</Badge> <span className="small">{text}</span>
      {error && <span className="small warn-text"> · {error}</span>}
    </li>
  );
  return (
    <Section title="MCP servers on this desk">
      <ul className="mcp-status">
        {line('Playwright', !!mcp.playwright.version, mcp.playwright.version ? `@playwright/mcp ${mcp.playwright.version}` : 'installing on first use', mcp.playwright.error)}
        {line('Microsoft 365', !!mcp.ms365.version, mcp.ms365.version ? `ms-365-mcp-server ${mcp.ms365.version}` : 'installed when the Microsoft app is set up', mcp.ms365.error)}
        {line(
          'Google Workspace',
          mcp.google.running,
          mcp.google.running ? `workspace-mcp ${mcp.google.version} on 127.0.0.1:${mcp.google.port}` : 'started when the Google app is set up (needs uv)',
          mcp.google.error,
        )}
      </ul>
    </Section>
  );
}
