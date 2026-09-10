export type ToastLevel = 'info' | 'warn' | 'error' | 'success';

export interface Toast {
  id: number;
  level: ToastLevel;
  text: string;
}

type Listener = (t: Toast) => void;
const listeners = new Set<Listener>();
let nextId = 1;

export function emitToast(level: ToastLevel, text: string): void {
  const t: Toast = { id: nextId++, level, text };
  for (const l of listeners) l(t);
}

export function onToast(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
