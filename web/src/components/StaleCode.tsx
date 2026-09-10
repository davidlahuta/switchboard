import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonInfo, StateSnapshot } from '@shared/types.ts';
import { ApiError, request } from '../lib/api.ts';
import { useStore } from '../lib/store.tsx';
import { timeAgo, useNow } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';
import { Icon, IconButton, Spinner } from './ui.tsx';

/**
 * The UI this tab is running was rebuilt since it loaded.
 *
 * A browser tab holds the scripts it fetched for as long as it stays open, so a rebuilt UI reaches
 * it only on a reload. Without saying so, a change made and deployed looks like a change that did
 * not work — which is the same trap as a stale daemon, one step further out.
 */
export function StaleWebBanner({ daemon }: { daemon: DaemonInfo }) {
  const loaded = useRef(daemon.webBuildId);
  if (daemon.webBuildId === 'none' || daemon.webBuildId === loaded.current) return null;
  return (
    <div className="stale-banner" role="status">
      <Icon name="refresh" size={16} />
      <span className="stale-text">
        <strong>This page is running an older Switchboard UI.</strong> It was rebuilt after you opened this tab.
      </span>
      <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

/** POST /api/service/restart — mirrored from the daemon route, not in shared/types.ts. */
interface RestartDaemonResult {
  ok: boolean;
  restarting: boolean;
}

/** Long enough to cover the supervisor's ~10s relaunch plus a slow start. */
const GIVE_UP_MS = 90_000;
const FIRST_POLL_MS = 1500;
const POLL_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

type Phase = 'idle' | 'restarting' | 'timeout';

/**
 * Restarting the daemon is a request that deliberately kills the thing answering it: the response
 * arrives, the process exits, and the supervisor relaunches it. So a dropped connection here is the
 * expected shape of success, and the only way to know it worked is to wait for a *different*
 * process — one reporting a newer startedAt — to start answering.
 */
function useDaemonRestart(startedAt: string) {
  const { refresh } = useStore();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const restart = useCallback(async () => {
    setError(null);
    setPhase('restarting');
    try {
      await request<RestartDaemonResult>('POST', '/api/service/restart', {});
    } catch (e) {
      // Status 0 is "could not reach it" — which is what a daemon exiting mid-reply looks like.
      // A real refusal (409: nothing would relaunch it) is a failure and stops here.
      if (e instanceof ApiError && e.status !== 0) {
        if (alive.current) {
          setError(e.message);
          setPhase('idle');
        }
        return;
      }
    }

    const deadline = Date.now() + GIVE_UP_MS;
    await sleep(FIRST_POLL_MS);
    for (;;) {
      if (!alive.current) return;
      try {
        const s = await request<StateSnapshot>('GET', '/api/state');
        if (s.daemon.startedAt !== startedAt) break;
      } catch {
        /* still down — that is what we are waiting through */
      }
      if (Date.now() > deadline) {
        if (alive.current) setPhase('timeout');
        emitToast('warn', 'The daemon has not answered yet. Check the log from Settings → Automatic start.');
        return;
      }
      await sleep(POLL_MS);
    }

    await refresh();
    if (alive.current) setPhase('idle');
    emitToast('success', 'Daemon restarted on the current code');
  }, [refresh, startedAt]);

  return { phase, error, restart };
}

function staleLine(daemon: DaemonInfo, now: number): string {
  const when = daemon.sourceChangedAt ? timeAgo(daemon.sourceChangedAt, now) : 'recently';
  return `Switchboard is running code older than the working tree — the source changed ${when}. Changes take effect only after the daemon restarts.`;
}

// ---------------- app-shell banner ----------------

const DISMISS_KEY = 'sb.stale.dismissed';

function readDismissed(): string {
  try {
    return sessionStorage.getItem(DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Shown on every page while the daemon serves pre-edit code, because the symptom otherwise looks
 * like a UI bug: a setting saves, the daemon drops a field it has never heard of, and nothing
 * anywhere says why. Dismissed per browser session, and again per new source change.
 */
export function StaleCodeBanner({ daemon }: { daemon: DaemonInfo }) {
  const now = useNow(30_000);
  const { phase, error, restart } = useDaemonRestart(daemon.startedAt);
  const [dismissed, setDismissed] = useState(readDismissed);
  const key = `${daemon.startedAt}|${daemon.sourceChangedAt ?? ''}`;

  const dismiss = () => {
    setDismissed(key);
    try {
      sessionStorage.setItem(DISMISS_KEY, key);
    } catch {
      /* a session with no storage just gets the banner back on reload */
    }
  };

  if (!daemon.staleCode) return null;
  if (dismissed === key && phase === 'idle' && !error) return null;

  const canRestart = daemon.local && daemon.supervised;

  return (
    <div className="app-banner" role="status">
      {phase === 'restarting' ? <Spinner label="Restarting the daemon" /> : <Icon name="warn" size={16} />}
      <span className="app-banner-text">
        {phase === 'restarting' ? (
          <>Restarting the daemon — it comes back in about ten seconds. The live connection drops and reconnects on its own.</>
        ) : phase === 'timeout' ? (
          <>The daemon has not come back yet. Give it a moment, or check the log from Settings → Automatic start.</>
        ) : (
          <>
            {staleLine(daemon, now)}
            {!daemon.supervised && ' Nothing is supervising it, so restart it yourself.'}
            {daemon.supervised && !daemon.local && ' It has to be restarted from the desk itself.'}
          </>
        )}
        {error && <span className="app-banner-error"> {error}</span>}
      </span>
      <span className="app-banner-actions">
        {canRestart && (
          <button type="button" className="btn btn-sm" disabled={phase === 'restarting'} onClick={() => void restart()}>
            <Icon name="refresh" size={14} />
            <span>{phase === 'restarting' ? 'Restarting…' : 'Restart daemon'}</span>
          </button>
        )}
        <IconButton icon="x" label="Dismiss this notice" onClick={dismiss} disabled={phase === 'restarting'} />
      </span>
    </div>
  );
}

// ---------------- settings ----------------

/**
 * The same notice, where someone would deliberately go looking for it. No dismiss: this one is
 * part of the section that explains how the daemon is kept alive in the first place.
 */
export function StaleCodeNotice({ daemon }: { daemon: DaemonInfo }) {
  const now = useNow(30_000);
  const { phase, error, restart } = useDaemonRestart(daemon.startedAt);

  if (!daemon.staleCode) {
    return (
      <p className="field-hint">
        Running the current source{daemon.sourceChangedAt ? `, last changed ${timeAgo(daemon.sourceChangedAt, now)}` : ''}.
      </p>
    );
  }

  return (
    <div className="callout callout-warn stale-notice">
      <div>
        {phase === 'restarting'
          ? 'Restarting the daemon — it comes back in about ten seconds. The live connection drops and reconnects on its own.'
          : phase === 'timeout'
            ? 'The daemon has not come back yet. Give it a moment, or check the log above.'
            : staleLine(daemon, now)}
        {error && <span className="warn"> {error}</span>}
      </div>
      <div className="row-actions">
        {daemon.supervised ? (
          <button type="button" className="btn btn-sm" disabled={phase === 'restarting'} onClick={() => void restart()}>
            {phase === 'restarting' ? <Spinner label="Restarting the daemon" /> : <Icon name="refresh" size={14} />}
            <span>{phase === 'restarting' ? 'Restarting…' : 'Restart daemon'}</span>
          </button>
        ) : (
          <span className="field-hint">Install the logon task below to restart it from here; otherwise restart it yourself.</span>
        )}
      </div>
    </div>
  );
}
