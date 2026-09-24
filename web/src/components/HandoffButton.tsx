import { useState } from 'react';
import type { Run } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { emitToast } from '../lib/toast.ts';
import { Icon } from './ui.tsx';

/**
 * Give the terminal back to the window the session runs in — or, when it already has it, take it.
 *
 * One pseudo-terminal has one size. While a browser is fitted to its own screen it owns that size,
 * and the desktop terminal is parked rather than shown a frame drawn for other dimensions. This is
 * how you take it back without going to the machine.
 *
 * While the page is following the desktop terminal there is nothing to hand back, and the button
 * turns into the other half of the same switch: fit the terminal to this screen. One button then
 * moves the terminal between the two, whichever side has it.
 */
export function HandoffButton({
  run,
  compact,
  onHandoff,
  following,
  onFit,
}: {
  run: Run;
  compact?: boolean;
  onHandoff?: () => void;
  /** The page is showing the desktop terminal at its size, so the button offers to fit instead. */
  following?: boolean;
  onFit?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const disabled = run.status === 'exited' || run.status === 'disconnected' || busy;

  if (following && onFit) {
    return (
      <button
        type="button"
        className={compact ? 'btn btn-sm' : 'btn'}
        onClick={onFit}
        disabled={run.status === 'exited'}
        aria-label={`Fit ${run.name} to this screen`}
        title="Take the terminal over and fit it to this screen"
      >
        <Icon name="fit" size={16} />
        <span>Fit to this screen</span>
      </button>
    );
  }

  const handoff = async () => {
    setBusy(true);
    const ok = await api.post(`/api/runs/${encodeURIComponent(run.id)}/handoff`);
    setBusy(false);
    if (ok) {
      onHandoff?.();
      emitToast('info', `${run.name} is back on its own terminal`);
    }
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
