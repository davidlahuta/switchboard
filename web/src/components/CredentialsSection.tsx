import { useEffect, useState } from 'react';
import { Badge, ConfirmDialog, Dialog, Empty, Icon, IconButton, Section } from './ui.tsx';
import { api, request } from '../lib/api.ts';
import { emitToast } from '../lib/toast.ts';

type Kind = 'github-app' | 'github-pat' | 'ado-pat' | 'azure-sp';

interface Profile {
  id: string;
  kind: Kind;
  label: string;
  scope: string;
  config: Record<string, string>;
  hasSecret: boolean;
  sealed: boolean;
  updatedAt: string;
}

const KIND: Record<Kind, { name: string; scope: string; secret: string; fields: Array<{ key: string; label: string; hint?: string; optional?: boolean }>; help: string }> = {
  'github-app': {
    name: 'GitHub App',
    scope: 'github.com/<org>/*',
    secret: 'Private key (.pem contents)',
    fields: [
      { key: 'appId', label: 'App ID' },
      { key: 'owner', label: 'Default owner', hint: 'The org or user gh uses outside a repository', optional: true },
    ],
    help: 'Sessions get a one-hour installation token for the owner of each repository, minted on the hub when git or gh asks. Install the App on every org it should reach.',
  },
  'github-pat': {
    name: 'GitHub token',
    scope: 'github.com/*',
    secret: 'Fine-grained personal access token',
    fields: [],
    help: 'A long-lived token: prefer a GitHub App where you can.',
  },
  'ado-pat': {
    name: 'Azure DevOps PAT',
    scope: 'dev.azure.com/<org>/*',
    secret: 'Personal access token',
    fields: [{ key: 'user', label: 'User name', hint: 'Any value works for a PAT', optional: true }],
    help: 'Used by git for dev.azure.com and by the az devops extension (AZURE_DEVOPS_EXT_PAT).',
  },
  'azure-sp': {
    name: 'Azure service principal',
    scope: 'azure',
    secret: 'Client secret',
    fields: [
      { key: 'tenantId', label: 'Tenant ID' },
      { key: 'clientId', label: 'Client (app) ID' },
      { key: 'subscriptionId', label: 'Subscription ID', optional: true },
    ],
    help: 'az is signed in as it for each call (in a config folder of its own), and the Azure SDKs read it from AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET.',
  },
};

/**
 * The hub's credentials for GitHub and Azure. Secrets go in and never come back out; sessions on
 * any desk get what they need when git, gh or az asks.
 */
export function CredentialsSection() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [editing, setEditing] = useState<Profile | { kind: Kind } | null>(null);
  const [removing, setRemoving] = useState<Profile | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = (): void => void request<Profile[]>('GET', '/api/creds').then(setProfiles, () => setProfiles([]));
  useEffect(load, []);

  const test = async (p: Profile) => {
    setTesting(p.id);
    const r = await api.post<{ ok: boolean; detail: string }>(`/api/creds/${p.id}/test`);
    setTesting(null);
    if (r) emitToast(r.ok ? 'success' : 'error', `${p.label}: ${r.detail}`);
  };

  return (
    <Section
      title="Credentials for sessions"
      count={profiles?.length}
      actions={
        <select
          className="input input-sm"
          value=""
          aria-label="Add a credential"
          onChange={(e) => e.target.value && setEditing({ kind: e.target.value as Kind })}
        >
          <option value="">Add…</option>
          {(Object.keys(KIND) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND[k].name}
            </option>
          ))}
        </select>
      }
    >
      <p className="hint">
        Kept on this hub, sealed to this Windows user, and handed out per request — git through a credential helper scoped to the hosts
        below, gh and az through shims that fetch a fresh token each call. A satellite never stores them. With nothing here, sessions use
        whatever each desk is logged in to.
      </p>
      {profiles === null ? null : profiles.length === 0 ? (
        <Empty icon="key">No credentials yet. Add a GitHub App first: it is what lets a fresh desk clone and push without logging in.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="rtable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Covers</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.label}
                    {!p.sealed && (
                      <Badge tone="warn" title="DPAPI was not available, so the secret is stored in plain text in the hub's database">
                        not sealed
                      </Badge>
                    )}
                  </td>
                  <td>{KIND[p.kind]?.name ?? p.kind}</td>
                  <td className="mono small">{p.scope}</td>
                  <td className="row-actions">
                    <button type="button" className="btn btn-sm" disabled={testing === p.id} onClick={() => void test(p)}>
                      {testing === p.id ? 'Testing…' : 'Test'}
                    </button>
                    <IconButton icon="pencil" label={`Edit ${p.label}`} onClick={() => setEditing(p)} />
                    <IconButton icon="trash" label={`Remove ${p.label}`} variant="danger" onClick={() => setRemoving(p)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CredentialDialog initial={editing} onClose={() => setEditing(null)} onSaved={load} />}
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.label ?? 'credential'}?`}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const p = removing;
          setRemoving(null);
          if (p) void api.del(`/api/creds/${p.id}`).then(load);
        }}
        onCancel={() => setRemoving(null)}
      >
        <p>Sessions stop getting it from their next git, gh or az call. Tokens it already issued keep working until they expire.</p>
      </ConfirmDialog>
    </Section>
  );
}

function CredentialDialog({ initial, onClose, onSaved }: { initial: Profile | { kind: Kind }; onClose: () => void; onSaved: () => void }) {
  const existing = 'id' in initial ? initial : null;
  const k = KIND[initial.kind];
  const [label, setLabel] = useState(existing?.label ?? k.name);
  const [scope, setScope] = useState(existing?.scope ?? '');
  const [config, setConfig] = useState<Record<string, string>>(existing?.config ?? {});
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const body = { kind: initial.kind, label, scope, config, ...(secret.trim() ? { secret } : {}) };
    const r = existing ? await api.patch(`/api/creds/${existing.id}`, body) : await api.post('/api/creds', body);
    setBusy(false);
    if (r) {
      emitToast('success', `${label} saved`);
      onSaved();
      onClose();
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.label}` : `Add ${k.name}`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !scope.trim() || (!existing && !secret.trim())} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form">
        <p className="hint">{k.help}</p>
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Covers</span>
          <input className="input mono" value={scope} placeholder={k.scope} onChange={(e) => setScope(e.target.value)} />
          <span className="field-hint">A host and a path pattern. The most specific one that matches a repository's origin is used.</span>
        </label>
        {k.fields.map((f) => (
          <label key={f.key} className="field">
            <span className="field-label">
              {f.label} {f.optional && <span className="optional">optional</span>}
            </span>
            <input className="input mono" value={config[f.key] ?? ''} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
            {f.hint && <span className="field-hint">{f.hint}</span>}
          </label>
        ))}
        <label className="field">
          <span className="field-label">
            {k.secret} {existing && <span className="optional">leave empty to keep the stored one</span>}
          </span>
          {initial.kind === 'github-app' ? (
            <textarea className="input mono" rows={5} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="-----BEGIN RSA PRIVATE KEY-----" />
          ) : (
            <input className="input mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          )}
          <span className="field-hint">
            <Icon name="key" size={12} /> Sealed with DPAPI on the hub and never shown again.
          </span>
        </label>
      </div>
    </Dialog>
  );
}
