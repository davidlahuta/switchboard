import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AuthStatus } from '@shared/types.ts';
import { request } from '../lib/api.ts';
import { Icon } from '../components/ui.tsx';

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

export function PairPage({ initialCode, onPaired }: { initialCode: string | null; onPaired: (s: AuthStatus) => void }) {
  const [code, setCode] = useState(initialCode ?? '');
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);

  const pair = async (c: string, n: string) => {
    setBusy(true);
    setError(null);
    try {
      const s = await request<AuthStatus>('POST', '/api/auth/pair', { code: c.trim(), name: n.trim() || guessDeviceName() });
      if (s.paired || s.local) {
        if (location.hash.startsWith('#/pair')) location.hash = '#/';
        onPaired(s);
      } else {
        setError('Pairing was not accepted. Generate a new code on the desk.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialCode && !autoTried.current) {
      autoTried.current = true;
      void pair(initialCode, name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) void pair(code, name);
  };

  return (
    <div className="center-screen">
      <form className="panel narrow pair-panel" onSubmit={submit}>
        <div className="pair-icon" aria-hidden="true">
          <Icon name="phone" size={28} />
        </div>
        <h1 className="h1">Pair this device</h1>
        <p className="muted">
          On the desk, open Switchboard → Settings → <strong>Pair a device</strong>, then scan the QR code or type the code
          here.
        </p>
        <label className="field">
          <span className="field-label">Pairing code</span>
          <input
            className="input input-code mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            placeholder="ABCD-1234"
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Device name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !code.trim()}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </div>
  );
}
