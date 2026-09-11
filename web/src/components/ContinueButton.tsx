import { useState } from 'react';
import type { Run } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { emitToast } from '../lib/toast.ts';
import { Icon } from './ui.tsx';

/**
 * Tell a session to carry on, now.
 *
 * The daemon does this by itself for a session whose turn failed, on a backoff. This is the same
 * message a few minutes earlier, and it is worth a button of its own rather than a line in a menu
 * because it is the one thing an operator wants at the moment they notice a session sitting still:
 * a restart would do it too, at the cost of a resume the session did not need.
 */
export function ContinueButton({ run, compact }: { run: Run; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  // A session mid-turn is already carrying on, and one that has exited has nothing to carry on with.
  if (run.status === 'exited' || run.agentStatus === 'working' || run.agentStatus === 'starting') return null;

  const go = async () => {
    setBusy(true);
    const res = await api.post<{ ok: boolean }>(`/api/runs/${encodeURIComponent(run.id)}/continue`);
    setBusy(false);
    if (res) emitToast('info', `Telling ${run.name} to carry on`);
  };

  const why = run.stalled
    ? `It stopped on ${run.stalled.reason}. Send the continue message now rather than waiting for the next attempt.`
    : 'Send the continue message without restarting anything.';

  return (
    <button
      type="button"
      className={compact ? 'btn btn-sm' : 'btn'}
      onClick={(e) => {
        e.stopPropagation();
        void go();
      }}
      disabled={busy}
      aria-label={`Tell ${run.name} to carry on`}
      title={why}
    >
      <Icon name="bolt" size={14} />
      <span>{busy ? 'Sending…' : 'Continue'}</span>
    </button>
  );
}
