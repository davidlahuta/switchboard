import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { currentSubscription, deviceLabel, disablePush, enablePush, pushUnsupported } from '../lib/push.ts';
import { timeAgo } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';
import { Toggle } from './ui.tsx';

interface PushDevice {
  endpoint: string;
  device: string;
  needsYou: boolean;
  done: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}

/**
 * Notifications on this device, and the other devices that get them.
 *
 * Two kinds, each switchable per device: a session that needs you (a question, a permission, or a
 * session that has stopped retrying), and a session that is done — its turn over and nothing it
 * started still running or booked, for a minute. Tapping one opens that session.
 */
export function NotificationsSection() {
  const unsupported = pushUnsupported();
  const [mine, setMine] = useState<string | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const sub = await currentSubscription().catch(() => null);
    setMine(sub?.endpoint ?? null);
    setDevices((await api.get<PushDevice[]>('/api/push/devices')) ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  const here = devices.find((d) => d.endpoint === mine) ?? null;
  const others = devices.filter((d) => d.endpoint !== mine);

  const enable = async () => {
    setBusy(true);
    try {
      await enablePush(deviceLabel());
      emitToast('success', 'Notifications are on for this device');
      await load();
    } catch (err) {
      emitToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    await disablePush().catch(() => undefined);
    setBusy(false);
    await load();
  };

  const prefs = async (endpoint: string, change: Partial<Pick<PushDevice, 'needsYou' | 'done'>>) => {
    await api.post('/api/push/prefs', { endpoint, prefs: change });
    await load();
  };

  const test = async (endpoint: string) => {
    const res = await api.post<{ sent: number }>('/api/push/test', { endpoint });
    if (res?.sent) emitToast('info', 'Sent a test notification');
    else emitToast('warn', 'The test was not delivered — see the error under the device');
    await load();
  };

  const forget = async (endpoint: string) => {
    await api.post('/api/push/unsubscribe', { endpoint });
    await load();
  };

  return (
    <>
      <p className="setting-desc">
        A notification when a session <strong>needs you</strong> (a question, a permission, or it has stopped retrying), and
        when a session is <strong>done</strong>: its turn over and nothing it started — subagents, workflows, shells, monitors,
        loops — still running, for a minute. Tapping one opens that session. They arrive with the app closed.
      </p>

      {unsupported ? (
        <p className="field-hint">{unsupported}</p>
      ) : here ? (
        <DeviceRow device={here} current onPrefs={prefs} onTest={test} onRemove={() => void disable()} busy={busy} />
      ) : (
        <div className="setting">
          <div className="setting-text">
            <div className="setting-name">This device</div>
            <div className="setting-desc">Not receiving notifications.</div>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void enable()} disabled={busy}>
            {busy ? 'Asking…' : 'Turn on notifications'}
          </button>
        </div>
      )}

      {others.map((d) => (
        <DeviceRow key={d.endpoint} device={d} onPrefs={prefs} onTest={test} onRemove={() => void forget(d.endpoint)} busy={busy} />
      ))}
    </>
  );
}

function DeviceRow({
  device,
  current,
  onPrefs,
  onTest,
  onRemove,
  busy,
}: {
  device: PushDevice;
  current?: boolean;
  onPrefs: (endpoint: string, change: Partial<Pick<PushDevice, 'needsYou' | 'done'>>) => Promise<void>;
  onTest: (endpoint: string) => Promise<void>;
  onRemove: () => void;
  busy: boolean;
}) {
  return (
    <div className="quick-edit">
      <div className="setting-name">
        {current ? 'This device' : device.device}
        {current && <span className="dim small"> · {device.device}</span>}
      </div>
      <div className="setting">
        <div className="setting-text">
          <div className="setting-name">Needs you</div>
        </div>
        <Toggle checked={device.needsYou} onChange={(v) => void onPrefs(device.endpoint, { needsYou: v })} label="Notify when a session needs you" />
      </div>
      <div className="setting">
        <div className="setting-text">
          <div className="setting-name">Done</div>
        </div>
        <Toggle checked={device.done} onChange={(v) => void onPrefs(device.endpoint, { done: v })} label="Notify when a session is done" />
      </div>
      <div className="dim small">
        {device.lastSentAt ? `Last delivered ${timeAgo(device.lastSentAt)}.` : 'Nothing delivered yet.'}
        {device.lastError && <span className="warn"> Last attempt failed: {device.lastError}</span>}
      </div>
      <div className="quick-edit-actions">
        <button type="button" className="btn btn-sm" onClick={() => void onTest(device.endpoint)} disabled={busy}>
          Send a test
        </button>
        <button type="button" className="btn btn-sm btn-danger" onClick={onRemove} disabled={busy}>
          {current ? 'Turn off here' : 'Remove'}
        </button>
      </div>
    </div>
  );
}
