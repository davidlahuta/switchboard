import { request } from './api.ts';

/** How often a visible page says it is still here. The daemon forgets a page after 75s of silence. */
const BEAT_MS = 30_000;

/** A phone or a tablet: where notifications are wanted, rather than where the operator is working. */
export function isMobileDevice(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Tell the desk this page is open, whether it can be seen, and when it was last used.
 *
 * Notifications are for when the operator is away from the desk. Working at the desktop in the
 * browser, the phone buzzing for every session that finished was noise about something already on
 * screen. The daemon holds phone notifications back while a desktop page is visible and in use.
 * Started once per page; returns the function that stops it.
 */
export function startPresence(): () => void {
  const client = Math.random().toString(36).slice(2, 10);
  const mobile = isMobileDevice();
  let lastInput = Date.now();
  let sentAt = 0;

  const beat = () => {
    sentAt = Date.now();
    // Quietly: a missed beat is made up by the next, and a toast every thirty seconds would not be.
    request('POST', '/api/presence', {
      client,
      mobile,
      visible: document.visibilityState === 'visible',
      idleMs: Date.now() - lastInput,
    }).catch(() => undefined);
  };
  const used = () => {
    lastInput = Date.now();
    // Coming back to the page after a while is news; the regular beat carries the rest.
    if (Date.now() - sentAt > 10_000) beat();
  };

  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') beat();
  }, BEAT_MS);
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
  for (const e of events) window.addEventListener(e, used, { passive: true });
  document.addEventListener('visibilitychange', beat);
  beat();

  return () => {
    window.clearInterval(timer);
    for (const e of events) window.removeEventListener(e, used);
    document.removeEventListener('visibilitychange', beat);
  };
}
