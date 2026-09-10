import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthStatus, Device, PairingCode } from '../shared/types.ts';
import { type Db, now } from './db.ts';

const COOKIE = 'sb_device';
const CODE_TTL_MS = 10 * 60_000;
const MAX_FAILURES = 10;
const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'tailscale-user-login'];

interface DeviceRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen: string | null;
  revoked_at: string | null;
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  return hostHeader.split(':')[0].toLowerCase();
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Local requests (the desk itself, straight to the loopback socket, no proxy in between) need
 * nothing. Everything else — notably `tailscale serve`, which proxies from loopback but adds its
 * identity headers — must present a paired-device cookie.
 */
export class Auth {
  private readonly db: Db;
  private readonly codes = new Map<string, number>();
  private failures: number[] = [];

  constructor(db: Db) {
    this.db = db;
  }

  isLocal(req: IncomingMessage): boolean {
    if (!LOOPBACK_ADDR.has(req.socket.remoteAddress ?? '')) return false;
    if (!LOOPBACK_HOSTS.has(hostname(req.headers.host))) return false;
    return !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  }

  device(req: IncomingMessage): DeviceRow | null {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const row = this.db.get<DeviceRow>('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL', sha256(token));
    if (!row) return null;
    if (!row.last_seen || Date.now() - Date.parse(row.last_seen) > 60_000) this.db.run('UPDATE devices SET last_seen = ? WHERE id = ?', now(), row.id);
    return row;
  }

  status(req: IncomingMessage): AuthStatus {
    const local = this.isLocal(req);
    const device = this.device(req);
    return { local, paired: !!device, deviceName: device?.name ?? null };
  }

  allowed(req: IncomingMessage): boolean {
    return this.isLocal(req) || !!this.device(req);
  }

  /** Blocks cross-site requests from browsers (and DNS-rebinding pages). */
  originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      if (o.host === host) return true;
      return LOOPBACK_HOSTS.has(o.hostname) && LOOPBACK_HOSTS.has(hostname(req.headers.host));
    } catch {
      return false;
    }
  }

  createPairingCode(): PairingCode {
    for (const [c, exp] of this.codes) if (exp < Date.now()) this.codes.delete(c);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    const expires = Date.now() + CODE_TTL_MS;
    this.codes.set(code, expires);
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  pair(req: IncomingMessage, res: ServerResponse, code: string, name: string): AuthStatus {
    this.failures = this.failures.filter((t) => Date.now() - t < CODE_TTL_MS);
    if (this.failures.length >= MAX_FAILURES) throw Object.assign(new Error('Too many failed attempts; wait a few minutes.'), { status: 429 });
    const normalized = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const expires = this.codes.get(normalized);
    if (!expires || expires < Date.now()) {
      this.failures.push(Date.now());
      throw Object.assign(new Error('Invalid or expired pairing code.'), { status: 403 });
    }
    this.codes.delete(normalized);
    const token = crypto.randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    const deviceName = (name || 'device').trim().slice(0, 60);
    this.db.run('INSERT INTO devices (id, name, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)', id, deviceName, sha256(token), now(), now());
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`);
    return { local: this.isLocal(req), paired: true, deviceName };
  }

  devices(): Device[] {
    return this.db
      .all<DeviceRow>('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC')
      .map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen }));
  }

  revoke(id: string): void {
    this.db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', now(), id);
  }
}
