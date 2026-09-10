import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Run } from '@shared/types.ts';
import { api } from '../lib/api.ts';
import { Icon } from './ui.tsx';

/**
 * The session name, editable in place. Switchboard and Claude Code share one name: this writes it
 * here and the session picks it up on its next prompt, and a /rename inside the session comes back
 * the same way. Renaming from either side is therefore the same operation.
 */
export function SessionName({ run, as: Tag = 'span', href }: { run: Run; as?: 'span' | 'div'; href?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(run.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(run.name);
  }, [run.name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    const name = draft.trim();
    setEditing(false);
    if (!name || name === run.name) return;
    await api.patch<Run>(`/api/runs/${encodeURIComponent(run.id)}`, { name });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(run.name);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="input rename-input"
        value={draft}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => void commit()}
        aria-label="Session name"
      />
    );
  }

  return (
    <Tag className="rename-wrap">
      {href ? (
        <a href={href} className="run-name">
          {run.name}
        </a>
      ) : (
        <span className="run-name">{run.name}</span>
      )}
      <button
        type="button"
        className="btn btn-icon btn-ghost rename-btn"
        onClick={() => setEditing(true)}
        aria-label={`Rename ${run.name}`}
        title="Rename — the session is renamed too"
      >
        <Icon name="pencil" size={13} />
      </button>
    </Tag>
  );
}
