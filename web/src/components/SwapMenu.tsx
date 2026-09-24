import { useState } from 'react';
import { scopedBinds } from '@shared/limits.ts';
import type { Run, Subscription, SwapRequest } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { pctText, usableSubs, usageLevel } from '../lib/format.ts';
import { respawnToast, willWaitForTurn } from '../lib/respawn.ts';
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
  const disabled = run.status === 'exited' || run.status === 'swapping' || busy;

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
          <SwapSection run={run} subs={subs} force={force} close={close} onBusy={setBusy} />
          {run.swapsInPlace ? (
            <p className="menu-note">Moves at once without restarting: the turn in flight carries on, on the new subscription.</p>
          ) : (
            <>
              <label className="menu-check">
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                Force now (even mid-turn)
              </label>
              <p className="menu-note">
                Without this, a session that is mid-turn is queued and moved the moment the turn ends — nothing in flight is
                lost. Forcing kills the turn where it stands.
              </p>
            </>
          )}
        </div>
      )}
    </Popover>
  );
}

/** The subscriptions a session can be moved to, as menu items; shared by the Swap and Manage menus. */
export function SwapSection({
  run,
  subs,
  force,
  close,
  onBusy,
}: {
  run: Run;
  subs: Subscription[];
  force: boolean;
  close: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const options = usableSubs(subs);
  const disabled = run.status === 'exited' || run.status === 'swapping';
  // Mid-turn a swap is queued rather than refused, so say which one picking a subscription asks for.
  const queues = !run.swapsInPlace && willWaitForTurn(run, force);

  const swap = async (subscriptionId: string) => {
    close();
    onBusy?.(true);
    const body: SwapRequest = { subscriptionId, force: force || undefined };
    const res = await api.post<Run>(`/api/runs/${encodeURIComponent(run.id)}/swap`, body);
    onBusy?.(false);
    if (res) emitToast('info', respawnToast(res, 'Swapping', `moves to another subscription`));
  };

  return (
    <>
      <div className="menu-heading">{queues ? 'Swap to, when the turn ends' : 'Swap to'}</div>
      <button type="button" role="menuitem" className="menu-item" disabled={disabled} onClick={() => void swap('auto')}>
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
            disabled={current || disabled}
            onClick={() => void swap(s.id)}
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
              {/* A session on a model with a week of its own is held to that week too. */}
              {(s.usage?.scoped ?? [])
                .filter((w) => scopedBinds(w.label, run.model))
                .map((w) => (
                  <span key={w.label} className={`lvl-${usageLevel(w.pct)}`}>
                    {w.label} {pctText(w)}
                  </span>
                ))}
            </span>
          </button>
        );
      })}
      {options.length === 0 && <div className="menu-empty">No ready subscriptions</div>}
    </>
  );
}
