import { useState } from 'react';
import type { Run, Subscription, SwapRequest } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { pctText, usableSubs, usageLevel } from '../lib/format.ts';
import { emitToast } from '../lib/toast.ts';
import { Icon, Popover } from './ui.tsx';

export function SwapMenu({
  run,
  subs,
  compact,
  align = 'right',
}: {
  run: Run;
  subs: Subscription[];
  compact?: boolean;
  align?: 'left' | 'right';
}) {
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const options = usableSubs(subs);
  const disabled = run.status === 'exited' || run.status === 'swapping' || busy;

  const swap = async (subscriptionId: string, close: () => void) => {
    close();
    setBusy(true);
    const body: SwapRequest = { subscriptionId, force: force || undefined };
    const res = await api.post<Run>(`/api/runs/${encodeURIComponent(run.id)}/swap`, body);
    setBusy(false);
    if (res) emitToast('info', `Swapping ${run.name} → ${res.subscriptionLabel || 'next subscription'}`);
  };

  return (
    <Popover
      label="Swap subscription"
      align={align}
      trigger={(p) => (
        <button
          type="button"
          className={compact ? 'btn btn-sm' : 'btn'}
          disabled={disabled}
          aria-label={`Swap subscription for ${run.name}`}
          {...p}
        >
          <Icon name="swap" size={16} />
          <span>{run.status === 'swapping' ? 'Swapping…' : 'Swap'}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="swap-menu">
          <div className="menu-heading">Swap to</div>
          <button type="button" role="menuitem" className="menu-item" onClick={() => void swap('auto', close)}>
            <Icon name="bolt" size={16} />
            <span className="menu-item-main">
              <strong>Auto</strong>
              <span className="menu-sub">most headroom</span>
            </span>
          </button>
          {options.map((s) => {
            const current = s.id === run.subscriptionId;
            return (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                className={current ? 'menu-item current' : 'menu-item'}
                disabled={current}
                onClick={() => void swap(s.id, close)}
              >
                <span className="menu-item-main">
                  <strong>{s.label}</strong>
                  <span className="menu-sub">
                    {current ? 'current · ' : ''}
                    {s.liveRuns} live
                  </span>
                </span>
                <span className="menu-usage">
                  <span className={`lvl-${usageLevel(s.usage?.fiveHour?.pct)}`}>5h {pctText(s.usage?.fiveHour)}</span>
                  <span className={`lvl-${usageLevel(s.usage?.sevenDay?.pct)}`}>7d {pctText(s.usage?.sevenDay)}</span>
                </span>
              </button>
            );
          })}
          {options.length === 0 && <div className="menu-empty">No ready subscriptions</div>}
          <label className="menu-check">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force now (even mid-turn)
          </label>
        </div>
      )}
    </Popover>
  );
}
