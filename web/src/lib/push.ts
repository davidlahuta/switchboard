import { api } from './api.ts';

/** Why this device cannot receive notifications, or null when it can. */
export function pushUnsupported(): string | null {
  if (!window.isSecureContext) return 'Notifications need the secure address (https://…ts.net), not a plain http one.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // An iPhone gets Web Push only in a web app added to the Home Screen, and says nothing otherwise.
    if (isIos() && !isStandalone()) return 'On iPhone, add Switchboard to the Home Screen first (Share → Add to Home Screen), then open it from there.';
    return 'This browser cannot receive push notifications.';
  }
  return null;
}

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  return reg;
}

/** This device's subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushUnsupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Ask for permission, subscribe this device, and hand the subscription to the desk. Must be
 * called from a tap: browsers, iPhones above all, only ask for permission in answer to one.
 */
export async function enablePush(device: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site in the browser settings.' : 'Permission was not given.');
  const reg = await registration();
  const key = await api.get<{ publicKey: string }>('/api/push/key');
  if (!key) throw new Error('The desk did not answer.');
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key cannot be sent to with this one.
  if (sub && sub.options.applicationServerKey) {
    const had = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (had !== key.publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.publicKey) });
  const saved = await api.post('/api/push/subscribe', { subscription: sub.toJSON(), device });
  if (!saved) throw new Error('The desk did not keep the subscription.');
  return sub;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

/** A name for this device the list of subscribed devices can show. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return isStandalone() ? `${what} (Home Screen app)` : `${what}${browser ? ` · ${browser}` : ''}`;
}
