import { useEffect, useState } from 'react';
import { onToast, type Toast } from '../lib/toast.ts';
import { Icon } from './ui.tsx';

const TTL: Record<Toast['level'], number> = { info: 4000, success: 3000, warn: 6000, error: 8000 };
const MAX = 4;

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(
    () =>
      onToast((t) => {
        setToasts((ts) => {
          // collapse identical consecutive errors
          if (ts.some((x) => x.text === t.text && x.level === t.level)) return ts;
          return [...ts, t].slice(-MAX);
        });
        window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), TTL[t.level]);
      }),
    [],
  );

  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`} role={t.level === 'error' ? 'alert' : 'status'}>
          <span className="toast-text">{t.text}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
