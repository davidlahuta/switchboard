import { useState } from 'react';
import type { Run } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { emitToast } from '../lib/toast.ts';
import { Icon } from './ui.tsx';

/**
 * Give the terminal back to the window the session runs in.
 *
 * One pseudo-terminal has one size. While a browser is fitted to its own screen it owns that size,
 * and the desktop terminal is parked rather than shown a frame drawn for other dimensions. This is
 * how you take it back without going to the machine.
 */
export function HandoffButton({ run, compact }: { run: Run; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const disabled = run.status === 'exited' || run.status === 'disconnected' || busy;

  const handoff = async () => {
    setBusy(true);
    const ok = await api.post(`/api/runs/${encodeURIComponent(run.id)}/handoff`);
    setBusy(false);
    if (ok) emitToast('info', `${run.name} is back on its own terminal`);
  };

  return (
    <button
      type="button"
      className={compact ? 'btn btn-sm' : 'btn'}
      onClick={() => void handoff()}
      disabled={disabled}
      aria-label={`Hand ${run.name} back to its terminal`}
      title="Hand the terminal back to the window this session runs in"
    >
      <Icon name="handoff" size={16} />
      <span>Hand back</span>
    </button>
  );
}
