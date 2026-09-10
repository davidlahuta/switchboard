import { useState } from 'react';
import type { RelaunchRequest, RestartRequest, Run } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { emitToast } from '../lib/toast.ts';
import { Icon, Popover } from './ui.tsx';

/**
 * Restart the session in place: same subscription, same session GUID, resumed. Used to pick up a
 * new claude version. Same "Force now" affordance as the swap menu, because a restart interrupts
 * the agent exactly the same way.
 */
export function RestartMenu({
  run,
  compact,
  align = 'right',
}: {
  run: Run;
  compact?: boolean;
  align?: 'left' | 'right';
}) {
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const disabled = run.status === 'exited' || run.status === 'swapping' || busy;

  const restart = async (close: () => void) => {
    close();
    setBusy(true);
    const body: RestartRequest = { force: force || undefined };
    const res = await api.post<Run>(`/api/runs/${encodeURIComponent(run.id)}/restart`, body);
    setBusy(false);
    if (res) emitToast('info', `Restarting ${res.name}`);
  };

  const relaunch = async (close: () => void) => {
    close();
    setBusy(true);
    const body: RelaunchRequest = { force: force || undefined };
    const res = await api.post<Run>(`/api/runs/${encodeURIComponent(run.id)}/relaunch`, body);
    setBusy(false);
    if (res) emitToast('info', `Relaunching ${res.name} in a new terminal`);
  };

  return (
    <Popover
      label="Restart session"
      align={align}
      trigger={(p) => (
        <button
          type="button"
          className={compact ? 'btn btn-sm' : 'btn'}
          disabled={disabled}
          aria-label={`Restart ${run.name}`}
          {...p}
        >
          <Icon name="refresh" size={16} />
          <span>{busy ? 'Restarting…' : 'Restart'}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="swap-menu">
          <div className="menu-heading">Restart</div>
          <button type="button" role="menuitem" className="menu-item" onClick={() => void restart(close)}>
            <Icon name="refresh" size={16} />
            <span className="menu-item-main">
              <strong>Restart now</strong>
              <span className="menu-sub">
                stays on {run.subscriptionLabel}, resumes {run.sessionId.slice(0, 8)}
              </span>
            </span>
          </button>
          <p className="menu-note">Claude is relaunched on the installed version and resumes this session GUID, so nothing is lost.</p>
          <div className="menu-heading">New terminal</div>
          <button type="button" role="menuitem" className="menu-item" onClick={() => void relaunch(close)}>
            <Icon name="terminal" size={16} />
            <span className="menu-item-main">
              <strong>Relaunch in a new terminal</strong>
              <span className="menu-sub">{run.staleRunner ? 'this session is hosted by older Switchboard code' : 'picks up Switchboard updates'}</span>
            </span>
          </button>
          <p className="menu-note">
            The window this session runs in is opened by Switchboard and hosts part of it, so a restart in place keeps
            running the code it started with. This closes that window and opens a new one, resuming the same session GUID.
          </p>
          <label className="menu-check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force now (even mid-turn)
          </label>
        </div>
      )}
    </Popover>
  );
}
