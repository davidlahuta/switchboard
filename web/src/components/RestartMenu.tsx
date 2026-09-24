import { useState } from 'react';
import type { RelaunchRequest, RestartRequest, Run, UpdateRunRequest } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { respawnToast, willWaitForTurn } from '../lib/respawn.ts';
import { emitToast } from '../lib/toast.ts';
import { Icon, Popover } from './ui.tsx';

/**
 * Restart the session in place: same subscription, same session GUID, resumed. Used to pick up a
 * new claude version.
 *
 * Neither item here refuses to act mid-turn. Both are queued behind the turn and taken the moment
 * it ends, which is what an operator asking for a restart means by it; "Force now" is for when they
 * mean the other thing. The labels say which of the two the click is about to do.
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

  return (
    <Popover
      label="Restart session"
      align={align}
      trigger={(p) => (
        <button
          type="button"
          className={compact ? 'btn btn-sm' : 'btn'}
          disabled={disabled}
          aria-label={`Restart or resume ${run.name}`}
          {...p}
        >
          <Icon name="refresh" size={16} />
          <span>{busy ? 'Restarting…' : 'Restart'}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="swap-menu">
          <RestartSection run={run} force={force} close={close} onBusy={setBusy} />
          <ForceCheck force={force} onChange={setForce} />
          <CarryOnSection run={run} close={close} />
          <ContinueOnResume run={run} />
        </div>
      )}
    </Popover>
  );
}

/** Restart in place and relaunch in a new terminal, as menu items; shared by the Restart and Manage menus. */
export function RestartSection({
  run,
  force,
  close,
  onBusy,
  brief,
}: {
  run: Run;
  force: boolean;
  close: () => void;
  onBusy?: (busy: boolean) => void;
  /** Leave out the explanations, for a menu that holds more than restarting. */
  brief?: boolean;
}) {
  const disabled = run.status === 'exited' || run.status === 'swapping';
  // Says "now" or "when this turn ends" on the buttons themselves, because the difference is the
  // whole question an operator is weighing when they open this menu mid-turn.
  const queues = willWaitForTurn(run, force);

  const restart = async () => {
    close();
    onBusy?.(true);
    const body: RestartRequest = { force: force || undefined };
    const res = await api.post<Run>(`/api/runs/${encodeURIComponent(run.id)}/restart`, body);
    onBusy?.(false);
    if (res) emitToast('info', respawnToast(res, 'Restarting', 'restarts'));
  };

  const relaunch = async () => {
    close();
    onBusy?.(true);
    const body: RelaunchRequest = { force: force || undefined };
    const res = await api.post<Run>(`/api/runs/${encodeURIComponent(run.id)}/relaunch`, body);
    onBusy?.(false);
    if (res) emitToast('info', respawnToast(res, 'Relaunching', 'moves to a new terminal'));
  };

  return (
    <>
      <div className="menu-heading">Restart</div>
      <button type="button" role="menuitem" className="menu-item" disabled={disabled} onClick={() => void restart()}>
        <Icon name="refresh" size={16} />
        <span className="menu-item-main">
          <strong>{queues ? 'Restart when the turn ends' : 'Restart now'}</strong>
          <span className="menu-sub">
            stays on {run.subscriptionLabel}, resumes {run.sessionId.slice(0, 8)}
          </span>
        </span>
      </button>
      {!brief && (
        <p className="menu-note">Claude is relaunched on the installed version and resumes this session GUID, so nothing is lost.</p>
      )}
      {!brief && <div className="menu-heading">New terminal</div>}
      <button type="button" role="menuitem" className="menu-item" disabled={disabled} onClick={() => void relaunch()}>
        <Icon name="terminal" size={16} />
        <span className="menu-item-main">
          <strong>{queues ? 'New terminal when the turn ends' : 'Relaunch in a new terminal'}</strong>
          <span className="menu-sub">{run.staleRunner ? 'this session is hosted by older Switchboard code' : 'picks up Switchboard updates'}</span>
        </span>
      </button>
      {!brief && (
        <p className="menu-note">
          The window this session runs in is opened by Switchboard and hosts part of it, so a restart in place keeps
          running the code it started with. This closes that window and opens a new one, resuming the same session GUID.
        </p>
      )}
    </>
  );
}

/** The "Force now" choice that swaps and restarts in a menu share. */
export function ForceCheck({ force, onChange, brief }: { force: boolean; onChange: (on: boolean) => void; brief?: boolean }) {
  return (
    <>
      <label className="menu-check">
        <input type="checkbox" checked={force} onChange={(e) => onChange(e.target.checked)} />
        Force now (even mid-turn)
      </label>
      <p className="menu-note">
        {brief
          ? 'Without this, mid-turn is queued until the turn ends. Forcing kills the turn where it stands.'
          : 'Without this, a session that is mid-turn is queued and taken the moment the turn ends — nothing in flight is lost. Forcing kills the turn where it stands.'}
      </p>
    </>
  );
}

/** Nudge a session that stopped, without restarting anything. */
export function CarryOnSection({ run, close, brief }: { run: Run; close: () => void; brief?: boolean }) {
  const nudge = async () => {
    close();
    const res = await api.post<{ ok: boolean }>(`/api/runs/${encodeURIComponent(run.id)}/continue`);
    if (res) emitToast('info', `Telling ${run.name} to carry on`);
  };

  return (
    <>
      {!brief && <div className="menu-heading">Now</div>}
      <button type="button" role="menuitem" className="menu-item" disabled={run.status === 'exited'} onClick={() => void nudge()}>
        <Icon name="bolt" size={16} />
        <span className="menu-item-main">
          <strong>Tell it to carry on</strong>
          <span className="menu-sub">
            {run.stalled
              ? `it stopped on ${run.stalled.reason}${run.stalled.nextTry ? ' — this is what it will be told anyway, sooner' : ''}`
              : 'without restarting anything'}
          </span>
        </span>
      </button>
      {!brief && (
        <p className="menu-note">
          A session whose turn <em>failed</em> is told this on its own, on a backoff, until it has a turn that ends
          properly — that is what the <strong>stalled</strong> badge counts. This is the same message sent by hand, for
          when you would rather not wait for the next attempt. A session that stopped because it was finished is never
          told it, by either route. Anything already typed in its composer stays where it is.
        </p>
      )}
    </>
  );
}

/**
 * What this session does when it next comes back, changed in the menus where coming back is
 * decided. It applies to every resume, not only the ones started from a menu.
 */
export function ContinueOnResume({ run, brief }: { run: Run; brief?: boolean }) {
  const setContinue = async (on: boolean) => {
    const body: UpdateRunRequest = { continueOnResume: on };
    await api.patch<Run>(`/api/runs/${encodeURIComponent(run.id)}`, body);
  };

  return (
    <>
      <div className="menu-heading">When it comes back</div>
      <label className="menu-check">
        <input type="checkbox" checked={run.continueOnResume} onChange={(e) => void setContinue(e.target.checked)} />
        Send the continue message
      </label>
      {!brief && (
        <p className="menu-note">Applies to every resume of this session — a swap, a restart, a relaunch — not only the ones started here.</p>
      )}
    </>
  );
}
