import { useState, type ReactNode } from 'react';
import type { Run, Subscription } from '@shared/types.ts';
import { ApiError, api, request } from '../lib/api.ts';
import { emitToast } from '../lib/toast.ts';
import { CarryOnSection, ContinueOnResume, ForceCheck, RestartSection } from './RestartMenu.tsx';
import { SwapSection } from './SwapMenu.tsx';
import { ConfirmDialog, Icon, Popover } from './ui.tsx';

/** How long "stop and delete" waits for the stopped terminal to let go before giving up on the delete. */
const DELETE_WAIT_MS = 20_000;

/**
 * Everything that changes where or whether a session runs, behind one button: swap, restart,
 * relaunch, stop, and stop and delete. The terminal header has room for one menu, not three.
 */
export function ManageMenu({
  run,
  subs,
  compact,
  align = 'right',
  onDeleted,
  details,
}: {
  run: Run;
  subs: Subscription[];
  compact?: boolean;
  align?: 'left' | 'right';
  /** Called once the session is gone, so the page showing it can leave. */
  onDeleted?: () => void;
  /** Shown at the top of the menu; the terminal page puts the session's details here on a phone. */
  details?: ReactNode;
}) {
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'stop' | 'delete' | null>(null);
  const exited = run.status === 'exited';

  const stop = async (): Promise<boolean> => {
    const ok = !!(await api.post(`/api/runs/${encodeURIComponent(run.id)}/stop`));
    if (ok) emitToast('info', `Stopping ${run.name}`);
    return ok;
  };

  /**
   * The daemon refuses to delete a session whose terminal is still connected, and a stop takes a
   * moment to close it; so the delete is retried until it is let through, quietly, since those
   * refusals are the expected answer while the terminal closes.
   */
  const stopAndDelete = async () => {
    setBusy('Deleting…');
    if (!exited && !(await stop())) {
      setBusy(null);
      return;
    }
    const until = Date.now() + DELETE_WAIT_MS;
    for (;;) {
      try {
        await request('DELETE', `/api/runs/${encodeURIComponent(run.id)}`);
        emitToast('success', `${run.name} deleted`);
        setBusy(null);
        onDeleted?.();
        return;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409) || Date.now() > until) {
          emitToast('error', `${run.name} stopped but was not deleted: ${e instanceof Error ? e.message : String(e)}`);
          setBusy(null);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 750));
    }
  };

  const onConfirm = () => {
    const what = confirm;
    setConfirm(null);
    if (what === 'stop') void stop();
    else if (what === 'delete') void stopAndDelete();
  };

  return (
    <>
      <Popover
        label="Manage session"
        align={align}
        trigger={(p) => (
          <button
            type="button"
            className={compact ? 'btn btn-sm' : 'btn'}
            disabled={!!busy}
            aria-label={`Manage ${run.name}: swap, restart or stop`}
            {...p}
          >
            <Icon name="gear" size={16} />
            <span>{busy ?? (run.status === 'swapping' ? 'Swapping…' : 'Manage')}</span>
          </button>
        )}
      >
        {(close) => (
          <div className="swap-menu">
            {details}
            {!exited && (
              <>
                <SwapSection run={run} subs={subs} force={force} close={close} onBusy={(b) => setBusy(b ? 'Working…' : null)} />
                <RestartSection run={run} force={force} close={close} onBusy={(b) => setBusy(b ? 'Working…' : null)} brief />
                <CarryOnSection run={run} close={close} brief />
                {/* A hot swap never waits for the turn, but a restart does, so the choice stays. */}
                <ForceCheck force={force} onChange={setForce} brief />
                <ContinueOnResume run={run} brief />
              </>
            )}
            <div className="menu-heading">Stop</div>
            {!exited && (
              <button
                type="button"
                role="menuitem"
                className="menu-item menu-item-danger"
                onClick={() => {
                  close();
                  setConfirm('stop');
                }}
              >
                <Icon name="stop" size={16} />
                <span className="menu-item-main">
                  <strong>Stop session</strong>
                  <span className="menu-sub">closes its terminal; the conversation is kept</span>
                </span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="menu-item menu-item-danger"
              onClick={() => {
                close();
                setConfirm('delete');
              }}
            >
              <Icon name="trash" size={16} />
              <span className="menu-item-main">
                <strong>{exited ? 'Delete session' : 'Stop and delete session'}</strong>
                <span className="menu-sub">removes it from Switchboard</span>
              </span>
            </button>
          </div>
        )}
      </Popover>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'delete' ? `${exited ? 'Delete' : 'Stop and delete'} ${run.name}?` : `Stop ${run.name}?`}
        confirmLabel={confirm === 'delete' ? (exited ? 'Delete session' : 'Stop and delete') : 'Stop session'}
        danger
        onConfirm={onConfirm}
        onCancel={() => setConfirm(null)}
      >
        {confirm === 'delete' ? (
          <p>
            {exited ? '' : 'Claude Code will be terminated and its terminal closes. '}The session is removed from Switchboard, along
            with its screen history here. The conversation itself stays on disk, and can still be resumed from “New session →
            Session”.
          </p>
        ) : (
          <p>
            Claude Code will be terminated and its terminal closes. The session stays in Switchboard and can be resumed, and the
            conversation is kept.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
