import { useState } from 'react';
import type { QuickPrompt, Run, Settings } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { href } from '../lib/router.ts';
import { emitToast } from '../lib/toast.ts';
import { Dialog, Icon } from './ui.tsx';

/**
 * The prompts an operator types into sessions over and over, one click away from the terminal.
 *
 * Read when the list opens rather than kept on the page, so a prompt edited in Settings in another
 * tab is the one sent. Typing is the daemon's: it will not type over a dialog or over something the
 * operator has already started writing in the session's prompt, and says so.
 */
export function QuickPromptsButton({ run, disabled }: { run: Run; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<QuickPrompt[] | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  const show = async () => {
    setOpen(true);
    const settings = await api.get<Settings>('/api/settings');
    setPrompts(settings?.quickPrompts ?? []);
  };

  const send = async (p: QuickPrompt) => {
    setSending(p.id);
    const res = await api.post<{ ok: boolean }>(`/api/runs/${encodeURIComponent(run.id)}/prompt`, { text: p.text });
    setSending(null);
    if (!res) return; // the API layer has already said why
    emitToast('success', `Sent “${p.label}” to ${run.name}`);
    setOpen(false);
  };

  const busy = run.agentStatus === 'working' || run.agentStatus === 'starting';

  return (
    <>
      <button
        type="button"
        className="btn btn-icon btn-ghost"
        onClick={() => void show()}
        disabled={disabled}
        aria-label="Quick prompts"
        title="Quick prompts"
      >
        <Icon name="bolt" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Quick prompts">
        {busy && (
          <p className="dim small quick-note">
            {run.name} is working. A prompt sent now is queued by Claude Code and handed over when the session can take it.
          </p>
        )}
        {prompts === null ? (
          <p className="dim">Loading…</p>
        ) : prompts.length === 0 ? (
          <p className="dim">No quick prompts yet.</p>
        ) : (
          <ul className="quick-list">
            {prompts.map((p) => (
              <li key={p.id}>
                <button type="button" className="quick-item" onClick={() => void send(p)} disabled={sending !== null} title={p.text}>
                  <span className="quick-label">
                    {sending === p.id ? 'Sending…' : p.label}
                  </span>
                  <span className="quick-text">{p.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="small">
          <a href={href.settings()} onClick={() => setOpen(false)}>
            Edit quick prompts in Settings
          </a>
        </p>
      </Dialog>
    </>
  );
}
