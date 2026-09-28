import webpush from 'web-push';
import { logger } from '../log.ts';
import type { Db } from './db.ts';

const log = logger('push');

/** What each subscribed device wants to be told about. */
export interface PushPrefs {
  /** a session stopped on a question or a permission, or gave up retrying: nothing moves until you do */
  needsYou: boolean;
  /** a session with its turn over and nothing of its own left running or booked */
  done: boolean;
}

export interface PushDevice extends PushPrefs {
  endpoint: string;
  device: string;
  createdAt: string;
  lastSentAt: string | null;
  lastError: string | null;
}

interface SubRow {
  endpoint: string;
  keys: string;
  subject: string;
  device: string;
  needs_you: number;
  done: number;
  created_at: string;
  last_sent_at: string | null;
  last_error: string | null;
}

export interface PushMessage {
  title: string;
  body: string;
  /** where tapping it goes: the session's terminal */
  url: string;
  /** one notification per session: a newer one replaces the last */
  tag: string;
  kind: keyof PushPrefs | 'test';
}

/**
 * Web Push to the phones and browsers that asked for it.
 *
 * The page subscribes through its service worker and hands the subscription here; from then on the
 * browser's push service (Apple's, Google's, Mozilla's) delivers what is sent to it, with the page
 * closed and the phone locked. The daemon signs with its own VAPID key, made once and kept, since a
 * new key would orphan every subscription made with the old one.
 */
export class PushService {
  private readonly db: Db;
  private keys: { publicKey: string; privateKey: string } | null = null;

  constructor(db: Db) {
    this.db = db;
    db.raw.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      keys TEXT NOT NULL,
      subject TEXT NOT NULL,
      device TEXT NOT NULL,
      needs_you INTEGER NOT NULL DEFAULT 1,
      done INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_sent_at TEXT,
      last_error TEXT
    )`);
  }

  /** The key the page subscribes with. Made the first time it is asked for. */
  publicKey(): string {
    return this.vapid().publicKey;
  }

  private vapid(): { publicKey: string; privateKey: string } {
    if (this.keys) return this.keys;
    const row = this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'vapidKeys'");
    if (row) {
      try {
        this.keys = JSON.parse(row.value);
        if (this.keys?.publicKey && this.keys.privateKey) return this.keys;
      } catch {
        // made again below
      }
    }
    this.keys = webpush.generateVAPIDKeys();
    this.db.run(
      "INSERT INTO settings (key, value) VALUES ('vapidKeys', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(this.keys),
    );
    log.info('made the key push notifications are signed with');
    return this.keys;
  }

  /**
   * Keep a device's subscription. `subject` is the page's own origin: the push service wants a way
   * to reach whoever runs the sender, and Apple refuses one that says localhost.
   */
  subscribe(input: { subscription: unknown; device: string; origin: string; prefs?: Partial<PushPrefs> }): PushDevice {
    const sub = input.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof sub?.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) throw Object.assign(new Error('Not a push subscription'), { status: 400 });
    if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') throw Object.assign(new Error('The subscription has no keys'), { status: 400 });
    const subject = /^https:\/\//.test(input.origin) ? input.origin : 'mailto:switchboard@example.com';
    const prev = this.row(sub.endpoint);
    const needsYou = input.prefs?.needsYou ?? (prev ? prev.needs_you === 1 : true);
    const done = input.prefs?.done ?? (prev ? prev.done === 1 : true);
    this.db.run(
      `INSERT INTO push_subscriptions (endpoint, keys, subject, device, needs_you, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, subject = excluded.subject, device = excluded.device,
         needs_you = excluded.needs_you, done = excluded.done, last_error = NULL`,
      sub.endpoint,
      JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
      subject,
      input.device.slice(0, 80),
      needsYou ? 1 : 0,
      done ? 1 : 0,
      new Date().toISOString(),
    );
    log.info('a device subscribed to notifications', { device: input.device, needsYou, done });
    return this.device(sub.endpoint)!;
  }

  /** Change what one device is told about. */
  setPrefs(endpoint: string, prefs: Partial<PushPrefs>): PushDevice | null {
    if (typeof prefs.needsYou === 'boolean') this.db.run('UPDATE push_subscriptions SET needs_you = ? WHERE endpoint = ?', prefs.needsYou ? 1 : 0, endpoint);
    if (typeof prefs.done === 'boolean') this.db.run('UPDATE push_subscriptions SET done = ? WHERE endpoint = ?', prefs.done ? 1 : 0, endpoint);
    return this.device(endpoint);
  }

  unsubscribe(endpoint: string): boolean {
    return this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint).changes > 0;
  }

  device(endpoint: string): PushDevice | null {
    const r = this.row(endpoint);
    return r ? toDevice(r) : null;
  }

  devices(): PushDevice[] {
    return this.db.all<SubRow>('SELECT * FROM push_subscriptions ORDER BY created_at').map(toDevice);
  }

  private row(endpoint: string): SubRow | undefined {
    return this.db.get<SubRow>('SELECT * FROM push_subscriptions WHERE endpoint = ?', endpoint);
  }

  /** Send to every device that wants this kind, or to one device for a test. */
  async send(msg: PushMessage, onlyEndpoint?: string): Promise<number> {
    const rows = this.db
      .all<SubRow>('SELECT * FROM push_subscriptions')
      .filter((r) => (onlyEndpoint ? r.endpoint === onlyEndpoint : msg.kind === 'needsYou' ? r.needs_you === 1 : msg.kind === 'done' ? r.done === 1 : true));
    if (!rows.length) return 0;
    const { publicKey, privateKey } = this.vapid();
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag });
    let sent = 0;
    await Promise.all(
      rows.map(async (r) => {
        try {
          await webpush.sendNotification({ endpoint: r.endpoint, keys: JSON.parse(r.keys) }, payload, {
            TTL: 3600,
            urgency: msg.kind === 'needsYou' ? 'high' : 'normal',
            topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
            vapidDetails: { subject: r.subject, publicKey, privateKey },
          });
          sent++;
          this.db.run('UPDATE push_subscriptions SET last_sent_at = ?, last_error = NULL WHERE endpoint = ?', new Date().toISOString(), r.endpoint);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // Gone or not found: the device unsubscribed, or the browser dropped it. It will not come back.
          if (status === 404 || status === 410) {
            this.unsubscribe(r.endpoint);
            log.info('dropped a push subscription the push service no longer knows', { device: r.device, status });
            return;
          }
          const text = `${status ?? ''} ${(err as { body?: string }).body ?? (err instanceof Error ? err.message : String(err))}`.trim().slice(0, 300);
          this.db.run('UPDATE push_subscriptions SET last_error = ? WHERE endpoint = ?', text, r.endpoint);
          log.warn('a push notification was not delivered', { device: r.device, error: text });
        }
      }),
    );
    if (sent) log.info('sent a notification', { kind: msg.kind, title: msg.title, devices: sent });
    return sent;
  }
}

function toDevice(r: SubRow): PushDevice {
  return {
    endpoint: r.endpoint,
    device: r.device,
    needsYou: r.needs_you === 1,
    done: r.done === 1,
    createdAt: r.created_at,
    lastSentAt: r.last_sent_at,
    lastError: r.last_error,
  };
}
