import { useState } from 'react';
import type { Run, StateSnapshot } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { emitToast } from '../lib/toast.ts';
import { AccountPicker } from './NewSessionDialog.tsx';
import { Dialog, Icon } from './ui.tsx';

/**
 * The accounts a running session has, changed from its header. A claude cannot be given a new MCP
 * server while it runs, so saving restarts the session onto them once its turn is over.
 */
export function SessionAccountsButton({ run, state }: { run: Run; state: StateSnapshot }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const snap = state.accounts;
  if (!snap || !(snap.enabled.google || snap.enabled.microsoft) || !snap.accounts.length) return null;
  const current = run.accounts.map((a) => a.id);
  const save = async () => {
    setBusy(true);
    const r = await api.put<Run>(`/api/runs/${encodeURIComponent(run.id)}/accounts`, { accounts: picked });
    setBusy(false);
    if (!r) return;
    setOpen(false);
    const same = [...picked].sort().join(',') === [...current].sort().join(',');
    if (!same) emitToast('info', `${run.name} restarts with its new accounts when its turn is over.`);
  };
  return (
    <>
      <button
        type="button"
        className="btn btn-icon btn-ghost"
        onClick={() => {
          setPicked(current);
          setOpen(true);
        }}
        aria-label="Accounts"
        title={current.length ? `Accounts: ${run.accounts.map((a) => a.email).join(', ')}` : 'Accounts'}
      >
        <Icon name="user" />
        {current.length > 0 && <span className="tab-badge">{current.length}</span>}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Accounts for this session"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        }
      >
        <AccountPicker state={state} selected={picked} onChange={setPicked} />
        <p className="small dim">Changing them restarts the session when its turn is over; the conversation carries on.</p>
      </Dialog>
    </>
  );
}
