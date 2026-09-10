import { useState } from 'react';
import type { RestartRequest, Run } from '@shared/types.ts';
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
          <label className="menu-check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force now (even mid-turn)
          </label>
        </div>
      )}
    </Popover>
  );
}
