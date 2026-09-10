import { useEffect, useMemo, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import type { Device, IntegrationStatus, PairingCode, Settings, StateSnapshot } from '@shared/types.ts';
import { PageHead } from '../components/PageHead.tsx';
import { Badge, ConfirmDialog, Empty, Icon, Section, Spinner, Toggle } from '../components/ui.tsx';
import { api, request } from '../lib/api.ts';
import { countdown, timeAgo, useNow } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';

export function SettingsPage({ state }: { state: StateSnapshot }) {
  return (
    <div className="page settings-page">
      <PageHead title="Settings" subtitle={`Switchboard v${state.daemon.version} · port ${state.daemon.port}`} />
      <SettingsForm settings={state.settings} />
      <IntegrationSection />
      {state.daemon.local ? (
        <RemoteAccessSection port={state.daemon.port} />
      ) : (
        <Section title="Remote access">
          <p className="muted">Pairing and device management are only available from the desk itself.</p>
        </Section>
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

function parseArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function formatArgs(a: string[]): string {
  return a.map((x) => (/\s/.test(x) || x === '' ? `"${x}"` : x)).join(' ');
}

function SettingsForm({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [args, setArgs] = useState(formatArgs(settings.claudeArgs));
  const [busy, setBusy] = useState(false);

  // Pick up external changes when there are no local edits.
  const [base, setBase] = useState(settings);
  useEffect(() => {
    if (JSON.stringify(draft) === JSON.stringify(base) && args === formatArgs(base.claudeArgs)) {
      setDraft(settings);
      setArgs(formatArgs(settings.claudeArgs));
    }
    setBase(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const patch = useMemo(() => {
    const p: Partial<Settings> = {};
    const next = { ...draft, claudeArgs: parseArgs(args) };
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
      setArgs(formatArgs(res.claudeArgs));
      setBase(res);
      emitToast('success', 'Settings saved');
    }
  };

  const reset = () => {
    setDraft(settings);
    setArgs(formatArgs(settings.claudeArgs));
  };

  return (
    <Section title="Sessions & swapping">
      <form className="form settings-form" onSubmit={save}>
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
              min={15}
              step={5}
              value={draft.usagePollSec}
              onChange={(e) => set('usagePollSec', Number(e.target.value))}
            />
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

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={reset}>
            Discard changes
          </button>
        </div>
      </form>
    </Section>
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      emitToast('success', 'Link copied');
    } catch {
      emitToast('warn', 'Could not copy — select the link text instead');
    }
  };

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
