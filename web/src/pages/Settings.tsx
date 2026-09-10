import { useEffect, useMemo, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import type {
  DaemonInfo,
  Device,
  DiscoveredRepo,
  IntegrationStatus,
  Model,
  PairingCode,
  ServiceStatus,
  Settings,
  StateSnapshot,
  UpdateStatus,
} from '@shared/types.ts';
import { PageHead } from '../components/PageHead.tsx';
import { StaleCodeNotice } from '../components/StaleCode.tsx';
import { Badge, ConfirmDialog, Empty, Icon, IconButton, Section, Spinner, Toggle } from '../components/ui.tsx';
import { api, request } from '../lib/api.ts';
import { contextLabel, plural, tokensShort } from '../lib/format.ts';
import { joinArgs, splitArgs } from '../lib/argv.ts';
import { fetchDiscoveredRepos, groupRepos } from '../lib/repos.ts';
import { countdown, timeAgo, useNow } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';

/** Matches the daemon's clamp in src/daemon/settings.ts. */
const LIMITS = {
  updateCheckHours: { min: 1, max: 168 },
  autoCompactTokens: { min: 20_000, max: 990_000, step: 10_000 },
  // The usage endpoint is shared across subscriptions and rate-limits hard; 60s is the floor.
  usagePollSec: { min: 60, step: 30 },
} as const;

export function SettingsPage({ state }: { state: StateSnapshot }) {
  return (
    <div className="page settings-page">
      <PageHead title="Settings" subtitle={`Switchboard v${state.daemon.version} · port ${state.daemon.port}`} />
      <SettingsForm settings={state.settings} update={state.update} models={state.models} />
      <IntegrationSection />
      {state.daemon.local ? (
        <>
          <AutoStartSection daemon={state.daemon} />
          <RemoteAccessSection port={state.daemon.port} />
        </>
      ) : (
        <>
          <Section title="Automatic start">
            <p className="muted">Automatic start is configured from the desk itself.</p>
          </Section>
          <Section title="Remote access">
            <p className="muted">Pairing and device management are only available from the desk itself.</p>
          </Section>
        </>
      )}
      <Section title="Daemon">
        <dl className="kv">
          <dt>Version</dt>
          <dd>{state.daemon.version}</dd>
          <dt>Data directory</dt>
          <dd className="mono">{state.daemon.dataDir}</dd>
          <dt>Claude executable</dt>
          <dd className="mono">{state.daemon.claudePath ?? <span className="warn">not found on PATH</span>}</dd>
          <dt>Windows Terminal</dt>
          <dd>{state.daemon.wtAvailable ? 'available' : <span className="warn">not found</span>}</dd>
        </dl>
      </Section>
    </div>
  );
}

// ---------------- settings form ----------------

function SettingsForm({ settings, update, models }: { settings: Settings; update: UpdateStatus; models: Model[] }) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [args, setArgs] = useState(joinArgs(settings.claudeArgs));
  const [busy, setBusy] = useState(false);

  // Pick up external changes when there are no local edits.
  const [base, setBase] = useState(settings);
  useEffect(() => {
    if (JSON.stringify(draft) === JSON.stringify(base) && args === joinArgs(base.claudeArgs)) {
      setDraft(settings);
      setArgs(joinArgs(settings.claudeArgs));
    }
    setBase(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const patch = useMemo(() => {
    const p: Partial<Settings> = {};
    // Blank rows are what an unfinished "Add folder" looks like; the daemon drops them anyway, so
    // dropping them here too keeps the form from claiming an unsaved change that saves nothing.
    const next = { ...draft, claudeArgs: splitArgs(args), repoRoots: cleanRoots(draft.repoRoots) };
    (Object.keys(next) as Array<keyof Settings>).forEach((k) => {
      if (JSON.stringify(next[k]) !== JSON.stringify(settings[k])) (p as Record<string, unknown>)[k] = next[k];
    });
    return p;
  }, [draft, args, settings]);
  const dirty = Object.keys(patch).length > 0;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    const res = await api.patch<Settings>('/api/settings', patch);
    setBusy(false);
    if (res) {
      setDraft(res);
      setArgs(joinArgs(res.claudeArgs));
      setBase(res);
      emitToast('success', 'Settings saved');
    }
  };

  const reset = () => {
    setDraft(settings);
    setArgs(joinArgs(settings.claudeArgs));
  };

  return (
    <form className="form settings-form" onSubmit={save}>
      <Section title="Claude Code version">
        <UpdatePanel update={update} />

        <div className="setting">
          <div className="setting-text">
            <div className="setting-name">Keep claude up to date</div>
            <div className="setting-desc">Run <span className="mono">claude update</span> on a schedule so new versions land without you asking.</div>
          </div>
          <Toggle checked={draft.autoUpdate} onChange={(v) => set('autoUpdate', v)} label="Keep claude up to date" />
        </div>

        <div className="field-row">
          <label className="field field-narrow">
            <span className="field-label">Check every (hours)</span>
            <input
              type="number"
              className="input"
              min={LIMITS.updateCheckHours.min}
              max={LIMITS.updateCheckHours.max}
              step={1}
              value={draft.updateCheckHours}
              disabled={!draft.autoUpdate}
              onChange={(e) => set('updateCheckHours', Number(e.target.value))}
            />
            <span className="field-hint">1–168 (a week).</span>
          </label>
        </div>

        <div className="setting">
          <div className="setting-text">
            <div className="setting-name">Restart sessions after an update</div>
            <div className="setting-desc">
              When the version changes, each hosted session restarts by resuming the same session — as soon as it is idle, never mid-turn.
            </div>
          </div>
          <Toggle
            checked={draft.restartAfterUpdate}
            onChange={(v) => set('restartAfterUpdate', v)}
            label="Restart sessions after an update"
          />
        </div>
      </Section>

      <Section title="Session defaults">
        <p className="muted">These pre-fill the “New session” dialog. Changing them never touches a session that is already running.</p>

        <label className="field">
          <span className="field-label">Default model</span>
          <select
            className="input"
            value={draft.defaultModel ?? ''}
            disabled={models.length === 0}
            onChange={(e) => set('defaultModel', e.target.value || null)}
          >
            <option value="">Claude Code default</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} — {contextLabel(m)}
              </option>
            ))}
          </select>
          {models.length === 0 && (
            <span className="field-hint">
              Model list unavailable — sessions use the Claude Code default. Refresh it below once a subscription is signed in.
            </span>
          )}
        </label>

        <div className="form-actions">
          <RefreshModelsButton count={models.length} />
        </div>

        <div className="setting">
          <div className="setting-text">
            <div className="setting-name">Auto-compact by default</div>
            <div className="setting-desc">New sessions summarise their context automatically once it passes the threshold.</div>
          </div>
          <Toggle checked={draft.defaultAutoCompact} onChange={(v) => set('defaultAutoCompact', v)} label="Auto-compact by default" />
        </div>

        <div className="field-row">
          <label className="field field-narrow">
            <span className="field-label">Auto-compact at (tokens)</span>
            <input
              type="number"
              className="input"
              min={LIMITS.autoCompactTokens.min}
              max={LIMITS.autoCompactTokens.max}
              step={LIMITS.autoCompactTokens.step}
              value={draft.defaultAutoCompactTokens}
              disabled={!draft.defaultAutoCompact}
              onChange={(e) => set('defaultAutoCompactTokens', Number(e.target.value))}
            />
          </label>
          <span className={draft.defaultAutoCompact ? 'compact-value mono' : 'compact-value mono dim'} aria-hidden="true">
            {tokensShort(draft.defaultAutoCompactTokens)}
          </span>
        </div>

        <div className="setting">
          <div className="setting-text">
            <div className="setting-name">Skip permission prompts by default</div>
            <div className="setting-desc">New sessions run tools without asking you to approve each one.</div>
          </div>
          <Toggle
            checked={draft.defaultSkipPermissions}
            onChange={(v) => set('defaultSkipPermissions', v)}
            label="Skip permission prompts by default"
          />
        </div>
      </Section>

      <Section title="Repositories">
        <p className="muted">
          These folders are scanned up to three levels deep for git repositories, so starting a session is a pick from a list rather
          than a typed path.
        </p>

        {draft.repoRoots.length === 0 ? (
          <p className="field-hint">
            No folders configured. Add the folder your repositories live in — for example <span className="mono">C:\src</span>.
          </p>
        ) : (
          <ul className="root-list">
            {draft.repoRoots.map((root, i) => (
              // eslint-disable-next-line react/no-array-index-key -- the row *is* the position; the text is the state
              <li key={i} className="root-row">
                <input
                  type="text"
                  className="input mono"
                  value={root}
                  aria-label={`Repository folder ${i + 1}`}
                  placeholder="C:\src"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => set('repoRoots', draft.repoRoots.map((r, j) => (j === i ? e.target.value : r)))}
                />
                <IconButton
                  icon="trash"
                  label={`Remove ${root.trim() || `folder ${i + 1}`}`}
                  onClick={() => set('repoRoots', draft.repoRoots.filter((_, j) => j !== i))}
                />
              </li>
            ))}
          </ul>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-sm" onClick={() => set('repoRoots', [...draft.repoRoots, ''])}>
            <Icon name="plus" size={14} />
            <span>Add folder</span>
          </button>
          {cleanRoots(draft.repoRoots).join('|') !== settings.repoRoots.join('|') && (
            <span className="field-hint">Save to rescan with these folders.</span>
          )}
        </div>

        <DiscoveredRepos roots={settings.repoRoots} />
      </Section>

      <Section title="Sessions & swapping">
        <div className="setting">
          <div className="setting-text">
            <div className="setting-name">Auto-swap on limits</div>
            <div className="setting-desc">When a session hits a usage limit, resume it on the subscription with the most headroom.</div>
          </div>
          <Toggle checked={draft.autoSwap} onChange={(v) => set('autoSwap', v)} label="Auto-swap on limits" />
        </div>

        <div className="setting">
          <div className="setting-text">
            <div className="setting-name">Proactive swap</div>
            <div className="setting-desc">Swap idle sessions before they hit the limit, once their subscription crosses the threshold.</div>
          </div>
          <Toggle checked={draft.proactiveSwap} onChange={(v) => set('proactiveSwap', v)} label="Proactive swap" />
        </div>

        <label className="setting setting-stack">
          <span className="setting-text">
            <span className="setting-name">
              Swap threshold <span className="mono">{draft.swapThresholdPct}%</span>
            </span>
            <span className="setting-desc">5-hour utilisation at which proactive swapping kicks in.</span>
          </span>
          <input
            type="range"
            min={50}
            max={100}
            step={1}
            value={draft.swapThresholdPct}
            onChange={(e) => set('swapThresholdPct', Number(e.target.value))}
            disabled={!draft.proactiveSwap}
            className="range"
          />
        </label>

        <label className="field">
          <span className="field-label">Continue message</span>
          <textarea
            className="input"
            rows={2}
            value={draft.continueMessage}
            onChange={(e) => set('continueMessage', e.target.value)}
            placeholder="Continue where you left off."
          />
          <span className="field-hint">Typed into the session after an automatic swap caused by a limit. Leave empty to not type anything.</span>
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">Usage poll interval (s)</span>
            <input
              type="number"
              className="input"
              min={LIMITS.usagePollSec.min}
              step={LIMITS.usagePollSec.step}
              value={draft.usagePollSec}
              onChange={(e) => set('usagePollSec', Number(e.target.value))}
            />
            <span className="field-hint">At least {LIMITS.usagePollSec.min}s — the usage endpoint is shared by every subscription and rate-limits aggressively.</span>
          </label>
          <label className="field">
            <span className="field-label">Conflict window (min)</span>
            <input
              type="number"
              className="input"
              min={1}
              value={draft.conflictWindowMin}
              onChange={(e) => set('conflictWindowMin', Number(e.target.value))}
            />
            <span className="field-hint">Two agents editing the same file within this window opens a conflict.</span>
          </label>
        </div>

        <label className="field">
          <span className="field-label">Extra Claude arguments</span>
          <input
            className="input mono"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="--permission-mode auto"
            autoCapitalize="off"
            spellCheck={false}
          />
          <span className="field-hint">Space-separated, quote values with spaces. Added to every session Switchboard launches.</span>
        </label>
      </Section>

      <div className="form-actions settings-actions">
        <button type="submit" className="btn btn-primary" disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={reset}>
          Discard changes
        </button>
        {dirty && <span className="field-hint">{plural(Object.keys(patch).length, 'unsaved change')}</span>}
      </div>
    </form>
  );
}

// ---------------- repositories ----------------

/** Trimmed, non-empty roots — the same shape the daemon stores, so the diff is honest. */
function cleanRoots(roots: string[]): string[] {
  return roots.map((r) => r.trim()).filter((r) => r.length > 0);
}

/**
 * What the configured roots actually turned into. Shown next to the folder list because "56 repos"
 * is the only proof that a root is spelled right, and because a missing repo is nearly always a
 * root that points one level too deep.
 */
function DiscoveredRepos({ roots }: { roots: string[] }) {
  const [repos, setRepos] = useState<DiscoveredRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = roots.join('|');

  useEffect(() => {
    let cancelled = false;
    setRepos(null);
    setError(null);
    fetchDiscoveredRepos()
      .then((r) => !cancelled && setRepos(r))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [key]);

  const rescan = async () => {
    setBusy(true);
    try {
      const r = await fetchDiscoveredRepos(true);
      setRepos(r);
      setError(null);
      emitToast('success', `${plural(r.length, 'repository', 'repositories')} found`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => groupRepos(repos ?? []), [repos]);

  return (
    <div className="discovered">
      <div className="form-actions">
        <span className="field-hint">
          {error
            ? 'Discovery failed.'
            : repos === null
              ? 'Scanning…'
              : roots.length === 0
                ? 'No folders configured yet — nothing is scanned.'
                : `${plural(repos.length, 'repository', 'repositories')} in ${plural(roots.length, 'folder')}.`}
        </span>
        <button type="button" className="btn btn-sm" disabled={busy || roots.length === 0} onClick={() => void rescan()}>
          <Icon name="refresh" size={14} />
          <span>{busy ? 'Rescanning…' : 'Rescan'}</span>
        </button>
      </div>

      {error ? (
        <div className="callout callout-warn">{error}</div>
      ) : repos === null ? (
        <Spinner label="Scanning for repositories" />
      ) : repos.length === 0 ? (
        roots.length === 0 ? null : (
          <Empty icon="repo">No git repositories under those folders. Check the paths above.</Empty>
        )
      ) : (
        <ul className="list discovered-list">
          {groups.map((g) => (
            <li key={`${g.repoId}-${g.main.path}`}>
              <RepoLine repo={g.main} />
              {g.worktrees.length > 0 && (
                <ul className="list discovered-worktrees">
                  {g.worktrees.map((w) => (
                    <li key={w.path}>
                      <RepoLine repo={w} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RepoLine({ repo }: { repo: DiscoveredRepo }) {
  return (
    <div className="list-row discovered-row">
      <Icon name="repo" size={16} />
      <span className="list-main">
        <span className="list-title">
          {repo.name}
          {repo.isWorktree && (
            <>
              {' '}
              <Badge tone="muted" title={`Linked worktree of ${repo.mainWorktree}`}>
                worktree
              </Badge>
            </>
          )}
        </span>
        <span className="list-sub mono" title={repo.path}>
          {repo.path}
        </span>
      </span>
      <span className="dim small discovered-branch">{repo.branch ?? '—'}</span>
    </div>
  );
}

// ---------------- claude version ----------------

function UpdatePanel({ update }: { update: UpdateStatus }) {
  const now = useNow(30_000);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const busyCheck = checking || update.checking;

  const check = async () => {
    setChecking(true);
    const res = await api.post<UpdateStatus>('/api/update/check');
    setChecking(false);
    if (!res) return;
    if (res.lastError) emitToast('warn', res.lastError);
    else if (res.lastUpdate && Date.now() - Date.parse(res.lastUpdate.at) < 60_000) {
      emitToast('success', `Updated to claude ${res.lastUpdate.to}`);
    } else emitToast('info', `claude ${res.currentVersion ?? '?'} is the latest`);
  };

  const restartSessions = async () => {
    setRestarting(true);
    const res = await api.post<{ queued: number }>('/api/update/restart-sessions');
    setRestarting(false);
    if (!res) return;
    emitToast(
      'info',
      res.queued > 0 ? `${plural(res.queued, 'session')} will restart as soon as it is idle` : 'No live sessions to restart',
    );
  };

  return (
    <div className="update-panel">
      <dl className="kv">
        <dt>Installed</dt>
        <dd className="mono">{update.currentVersion ?? <span className="dim">unknown</span>}</dd>
        <dt>Last checked</dt>
        <dd>{update.lastCheckAt ? timeAgo(update.lastCheckAt, now) : <span className="dim">never</span>}</dd>
        <dt>Last update</dt>
        <dd>
          {update.lastUpdate ? (
            <>
              <span className="mono">
                {update.lastUpdate.from} → {update.lastUpdate.to}
              </span>
              , {timeAgo(update.lastUpdate.at, now)}
            </>
          ) : (
            <span className="dim">none seen yet</span>
          )}
        </dd>
        {update.pendingRestarts > 0 && (
          <>
            <dt>Queued</dt>
            <dd>
              <Badge tone="accent">
                {update.pendingRestarts === 1 ? '1 session restarts when idle' : `${update.pendingRestarts} sessions restart when idle`}
              </Badge>
            </dd>
          </>
        )}
      </dl>
      {update.lastError && <div className="callout callout-warn">{update.lastError}</div>}
      <div className="form-actions">
        <button type="button" className="btn" disabled={busyCheck} onClick={() => void check()}>
          {busyCheck ? <Spinner label="Checking for a new claude version" /> : <Icon name="refresh" size={16} />}
          <span>{busyCheck ? 'Checking…' : 'Check now'}</span>
        </button>
        <button type="button" className="btn" disabled={restarting} onClick={() => void restartSessions()}>
          <Icon name="swap" size={16} />
          <span>{restarting ? 'Queueing…' : 'Restart sessions now'}</span>
        </button>
      </div>
    </div>
  );
}

function RefreshModelsButton({ count }: { count: number }) {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    const res = await api.post<Model[]>('/api/models/refresh');
    setBusy(false);
    if (res) emitToast('success', `${plural(res.length, 'model')} available`);
  };
  return (
    <>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void refresh()}>
        <Icon name="refresh" size={14} />
        <span>{busy ? 'Refreshing…' : 'Refresh model list'}</span>
      </button>
      <span className="field-hint">{count === 0 ? 'No models cached' : `${plural(count, 'model')} available`}</span>
    </>
  );
}

// ---------------- Claude Code integration ----------------

function IntegrationSection() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.get<IntegrationStatus>('/api/integration').then((s) => s && setStatus(s));
  }, []);

  const run = async (action: 'install' | 'uninstall') => {
    setBusy(true);
    const s = await api.post<IntegrationStatus>(`/api/integration/${action}`);
    setBusy(false);
    if (s) {
      setStatus(s);
      emitToast('success', action === 'install' ? 'Integration installed' : 'Integration removed');
    }
  };

  const installed = status?.mcpInstalled && status.hooksInstalled;
  const partial = status && !installed && (status.mcpInstalled || status.hooksInstalled);

  return (
    <Section title="Claude Code integration">
      <p className="muted">
        Installs the <span className="mono">switchboard</span> MCP server and hooks globally (in <span className="mono">~/.claude.json</span> and{' '}
        <span className="mono">~/.claude/settings.json</span>) so sessions you start yourself also join their repo group. Sessions launched
        from Switchboard get them automatically either way.
      </p>
      {!status ? (
        <Spinner />
      ) : (
        <div className="integration">
          <div className="integration-items">
            <span>
              MCP server {status.mcpInstalled ? <Badge tone="ok">installed</Badge> : <Badge tone="muted">not installed</Badge>}
            </span>
            <span>
              Hooks {status.hooksInstalled ? <Badge tone="ok">installed</Badge> : <Badge tone="muted">not installed</Badge>}
            </span>
          </div>
          <div className="row-actions">
            {(!installed || partial) && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run('install')}>
                {partial ? 'Repair install' : 'Install'}
              </button>
            )}
            {(status.mcpInstalled || status.hooksInstalled) && (
              <button type="button" className="btn" disabled={busy} onClick={() => void run('uninstall')}>
                Uninstall
              </button>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// ---------------- automatic start ----------------

const DELAY_MIN = 0;
const DELAY_MAX = 300;

/** POST /api/service/install — not in shared/types.ts, mirrored from the daemon route. */
interface InstallServiceRequest {
  delaySeconds?: number;
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    emitToast('success', `${what} copied`);
  } catch {
    emitToast('warn', `Could not copy — select the ${what.toLowerCase()} and copy it manually`);
  }
}

/**
 * The daemon can register a Windows Task Scheduler logon task that keeps it alive. Desk only: the
 * task belongs to the signed-in user, and the endpoints 403 for a paired remote device.
 */
function AutoStartSection({ daemon }: { daemon: DaemonInfo }) {
  const now = useNow(30_000);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [delay, setDelay] = useState(20);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'install' | 'uninstall' | null>(null);

  const load = async () => {
    try {
      setStatus(await request<ServiceStatus>('GET', '/api/service'));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const run = async (action: 'install' | 'uninstall') => {
    setConfirming(null);
    setBusy(true);
    const body: InstallServiceRequest = { delaySeconds: clampDelay(delay) };
    const res = await api.post<ServiceStatus>(`/api/service/${action}`, action === 'install' ? body : {});
    setBusy(false);
    if (!res) return;
    setStatus(res);
    emitToast('success', action === 'install' ? 'Switchboard will start at logon' : 'Automatic start removed');
  };

  const supported = status?.supported ?? true;

  return (
    <Section title="Automatic start">
      <p className="muted">
        Switchboard starts <strong>when you sign in</strong>, not at boot — it opens Windows Terminal tabs, which needs an interactive
        desktop. After an unattended reboot it comes back as soon as the desk is signed in, and it is restarted within about ten seconds
        if it exits.
      </p>

      <p className="field-hint">
        This process started {timeAgo(daemon.startedAt, now)} on port {daemon.port}.
      </p>
      <StaleCodeNotice daemon={daemon} />

      {loadError ? (
        <div className="callout callout-crit">
          {loadError}{' '}
          <button type="button" className="link-btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : !status ? (
        <Spinner label="Reading the automatic-start status" />
      ) : !supported ? (
        <p className="field-hint">Automatic start is implemented for Windows Task Scheduler only.</p>
      ) : (
        <>
          <dl className="kv">
            <dt>Logon task</dt>
            <dd>{status.installed ? <Badge tone="ok">installed</Badge> : <Badge tone="muted">not installed</Badge>}</dd>
            <dt>Task state</dt>
            <dd>
              {status.state ?? <span className="dim">—</span>}
              {status.lastResult && <span className="dim small"> · last result {status.lastResult}</span>}
            </dd>
            <dt>Daemon</dt>
            <dd>{status.running ? <Badge tone="ok">running</Badge> : <Badge tone="warn">not answering</Badge>}</dd>
            <dt>Last run</dt>
            <dd>{status.lastRunTime ? timeAgo(status.lastRunTime, now) : <span className="dim">never</span>}</dd>
            <dt>Log file</dt>
            <dd className="log-path">
              <span className="mono" title={status.logPath}>
                {status.logPath}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void copyText(status.logPath, 'Log path')}
                aria-label="Copy the log file path"
              >
                <Icon name="paste" size={14} />
                <span>Copy</span>
              </button>
            </dd>
          </dl>

          <div className="field-row">
            <label className="field field-narrow">
              <span className="field-label">Delay after logon (s)</span>
              <input
                type="number"
                className="input"
                min={DELAY_MIN}
                max={DELAY_MAX}
                step={5}
                value={delay}
                disabled={busy}
                onChange={(e) => setDelay(Number(e.target.value))}
                onBlur={() => setDelay((d) => clampDelay(d))}
              />
              <span className="field-hint">Lets the desktop and network settle first. 0–{DELAY_MAX}s.</span>
            </label>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setConfirming('install')}>
              {busy ? 'Working…' : status.installed ? 'Reinstall task' : 'Install task'}
            </button>
            {status.installed && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirming('uninstall')}>
                Uninstall
              </button>
            )}
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void load()}>
              <Icon name="refresh" size={14} />
              <span>Refresh</span>
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming === 'install'}
        title={status?.installed ? 'Reinstall the logon task?' : 'Start Switchboard at logon?'}
        confirmLabel={status?.installed ? 'Reinstall' : 'Install'}
        busy={busy}
        onConfirm={() => void run('install')}
        onCancel={() => setConfirming(null)}
      >
        <p>
          Registers a Windows Task Scheduler task for your account that launches the daemon {clampDelay(delay)} seconds after you sign
          in and restarts it within about ten seconds if it exits.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'uninstall'}
        title="Remove automatic start?"
        confirmLabel="Uninstall"
        danger
        busy={busy}
        onConfirm={() => void run('uninstall')}
        onCancel={() => setConfirming(null)}
      >
        <p>The scheduled task is deleted. The daemon keeps running now, but will not come back on its own after a sign-out or reboot.</p>
      </ConfirmDialog>
    </Section>
  );
}

function clampDelay(v: number): number {
  if (!Number.isFinite(v)) return DELAY_MIN;
  return Math.min(DELAY_MAX, Math.max(DELAY_MIN, Math.round(v)));
}

// ---------------- remote access ----------------

const ORIGIN_KEY = 'sb.pair.origin';

function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const { n, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`;
    return { n: count + 8, path: d };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function RemoteAccessSection({ port }: { port: number }) {
  const now = useNow(1000);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [origin, setOrigin] = useState(() => {
    try {
      return localStorage.getItem(ORIGIN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDevices = async () => {
    try {
      setDevices(await request<Device[]>('GET', '/api/devices'));
    } catch (e) {
      setDevices([]);
      emitToast('error', e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void loadDevices();
  }, []);

  const expired = pairing ? Date.parse(pairing.expiresAt) <= now : false;

  // While a code is live, poll for the new device showing up.
  useEffect(() => {
    if (!pairing || expired) return;
    const t = window.setInterval(() => void loadDevices(), 4000);
    return () => window.clearInterval(t);
  }, [pairing, expired]);

  useEffect(() => {
    try {
      if (origin.trim()) localStorage.setItem(ORIGIN_KEY, origin.trim());
      else localStorage.removeItem(ORIGIN_KEY);
    } catch {
      /* ignore */
    }
  }, [origin]);

  const newCode = async () => {
    setBusy(true);
    const p = await api.post<PairingCode>('/api/pairing');
    setBusy(false);
    if (p) setPairing(p);
  };

  const base = (origin.trim() || location.origin).replace(/\/+$/, '');
  const link = pairing ? `${base}/#/pair?code=${encodeURIComponent(pairing.code)}` : '';
  const isLoopback = /^(localhost|127\.|\[::1\])/.test(location.hostname);

  const copy = () => copyText(link, 'Link');

  return (
    <Section title="Remote access">
      <div className="prose">
        <p>
          Switchboard only listens on <span className="mono">127.0.0.1</span>. To use it from your phone or another machine, expose it
          on your tailnet with Tailscale:
        </p>
        <pre className="code">tailscale serve --bg {port}</pre>
        <p className="muted">
          Then open <span className="mono">https://&lt;this-machine&gt;.&lt;tailnet&gt;.ts.net</span> on the other device and pair it
          with a one-time code. Remote devices need pairing; this desk never does.
        </p>
      </div>

      <div className="pair-box">
        {!pairing || expired ? (
          <div className="pair-start">
            {expired && <p className="warn">That code expired.</p>}
            <button type="button" className="btn btn-primary" onClick={() => void newCode()} disabled={busy}>
              <Icon name="phone" size={16} />
              {expired ? 'New code' : 'Pair a device'}
            </button>
          </div>
        ) : (
          <div className="pair-live">
            <div className="pair-qr">
              <QrCode text={link} />
            </div>
            <div className="pair-info">
              <div className="small dim">Pairing code</div>
              <div className="pair-code mono" aria-label={`Pairing code ${pairing.code.split('').join(' ')}`}>
                {pairing.code}
              </div>
              <div className="small">
                expires in <span className="mono">{countdown(pairing.expiresAt, now)}</span>
              </div>
              <label className="field">
                <span className="field-label">Origin the device will open</span>
                <input
                  className="input mono input-sm"
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                  placeholder={location.origin}
                  autoCapitalize="off"
                  spellCheck={false}
                />
                {isLoopback && !origin.trim() && (
                  <span className="field-hint warn">
                    {location.origin} only works on this machine — enter your tailnet URL, e.g. https://desk.tailnet-name.ts.net
                  </span>
                )}
              </label>
              <div className="pair-link mono small">{link}</div>
              <div className="row-actions">
                <button type="button" className="btn btn-sm" onClick={() => void copy()}>
                  <Icon name="link" size={14} />
                  Copy link
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPairing(null)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <h3 className="h3">Paired devices</h3>
      {devices === null ? (
        <Spinner />
      ) : devices.length === 0 ? (
        <Empty icon="phone">No paired devices.</Empty>
      ) : (
        <ul className="list">
          {devices.map((d) => (
            <li key={d.id} className="list-row">
              <Icon name="phone" />
              <span className="list-main">
                <span className="list-title">{d.name}</span>
                <span className="list-sub">
                  paired {timeAgo(d.createdAt, now)} · {d.lastSeen ? `last seen ${timeAgo(d.lastSeen, now)}` : 'never used'}
                </span>
              </span>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setRevoking(d)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!revoking}
        title={`Revoke ${revoking?.name ?? 'device'}?`}
        confirmLabel="Revoke"
        danger
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          const d = revoking;
          setRevoking(null);
          if (d)
            void api.del(`/api/devices/${encodeURIComponent(d.id)}`).then((ok) => {
              if (ok) void loadDevices();
            });
        }}
      >
        <p>The device loses access immediately and has to be paired again.</p>
      </ConfirmDialog>
    </Section>
  );
}
