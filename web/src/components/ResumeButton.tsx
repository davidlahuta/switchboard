import { useState } from 'react';
import type { RelaunchRequest, Run } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { emitToast } from '../lib/toast.ts';
import { Icon } from './ui.tsx';

/**
 * Bring a session back.
 *
 * A session outlives the terminal it was running in: the conversation is on disk and Switchboard
 * addresses it by GUID. So whether it exited on its own or the machine was switched off underneath
 * it, opening a new terminal on the same GUID picks it up where it stopped — which is the whole
 * point of never naming a session by anything but its id.
 */
export function ResumeButton({ run, compact }: { run: Run; compact?: boolean }) {
  const [busy, setBusy] = useState(false);

  // Nowhere to resume into. Claude Code would start, fail on the directory and exit on a Win32
  // error code, which reads like a crash rather than a moved folder.
  if (run.cwdMissing) {
    return (
      <button type="button" className={compact ? 'btn btn-sm' : 'btn'} disabled aria-label={`Cannot resume ${run.name}`} title={`${run.cwd} no longer exists`}>
        <Icon name="warn" size={16} />
        <span>Folder gone</span>
      </button>
    );
  }

  const resume = async () => {
    setBusy(true);
    const body: RelaunchRequest = { force: true };
    const res = await api.post<Run>(`/api/runs/${encodeURIComponent(run.id)}/relaunch`, body);
    setBusy(false);
    if (res) emitToast('info', `Resuming ${res.name}`);
  };

  return (
    <button
      type="button"
      className={compact ? 'btn btn-sm btn-primary' : 'btn btn-primary'}
      onClick={() => void resume()}
      disabled={busy}
      aria-label={`Resume ${run.name}`}
      title="Open a terminal and resume this conversation"
    >
      <Icon name="refresh" size={16} />
      <span>{busy ? 'Resuming…' : 'Resume'}</span>
    </button>
  );
}
