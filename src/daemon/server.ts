import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { DATA_DIR, PACKAGE_ROOT, PORT, VERSION, WEB_DIST } from '../config.ts';
import { logger } from '../log.ts';
import type { StateSnapshot, Totals } from '../shared/types.ts';
import type { AgentHub } from './agents.ts';
import type { Auth } from './auth.ts';
import type { Bus } from './bus.ts';
import { findClaude } from './claude.ts';
import type { Coordinator } from './coord.ts';
import type { Db } from './db.ts';
import type { RepoScanner } from './discovery.ts';
import { createHookHandler } from './hooks.ts';
import { installIntegration, integrationStatus, uninstallIntegration } from './integration.ts';
import type { Launcher } from './launcher.ts';
import type { ModelCatalog } from './models.ts';
import type { RunManager } from './runs.ts';
import { installService, isSupervised, serviceStatus, startService, uninstallService } from './service.ts';
import { getSettings, updateSettings } from './settings.ts';
import type { SubscriptionManager } from './subscriptions.ts';
import type { Updater } from './updater.ts';

const log = logger('http');

const STARTED_AT = new Date().toISOString();
let srcMtime: { at: number; value: number } | null = null;

/**
 * Newest mtime under src/. The daemon executes TypeScript directly and its supervisor only
 * relaunches it on exit, so an edit or a git pull leaves it serving old code until it restarts.
 * Reporting this lets the UI say so, instead of the change looking like a bug.
 */
function newestSourceMtime(): number {
  if (srcMtime && Date.now() - srcMtime.at < 10_000) return srcMtime.value;
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.ts')) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch {
          // vanished mid-scan
        }
      }
    }
  };
  walk(path.join(PACKAGE_ROOT, 'src'));
  srcMtime = { at: Date.now(), value: newest };
  return newest;
}

export interface Services {
  db: Db;
  bus: Bus;
  coord: Coordinator;
  subs: SubscriptionManager;
  runs: RunManager;
  auth: Auth;
  launcher: Launcher;
  hub: AgentHub;
  updater: Updater;
  models: ModelCatalog;
  scanner: RepoScanner;
}

type Body = Record<string, any>;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  url: URL;
  body: Body;
}
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  /** 'public': no auth; 'local': desk only; default: local or paired device */
  access?: 'public' | 'local';
}

const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data ?? { ok: true });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Body> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) fail(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return fail(400, 'Invalid JSON');
  }
}

export function createServer(s: Services): http.Server {
  const hook = createHookHandler(s.coord, s.runs);

  const state = (req: IncomingMessage): StateSnapshot => {
    const subscriptions = s.subs.list();
    const totals: Totals = { capacity: 0, fiveHourRemaining: 0, sevenDayRemaining: 0, liveRuns: s.runs.liveCount(), agentsOnline: s.coord.agentsOnline() };
    for (const sub of subscriptions) {
      if (!sub.enabled || sub.status !== 'ready') continue;
      totals.capacity += sub.weight;
      totals.fiveHourRemaining += (sub.weight * (100 - (sub.usage?.fiveHour?.pct ?? 0))) / 100;
      totals.sevenDayRemaining += (sub.weight * (100 - (sub.usage?.sevenDay?.pct ?? 0))) / 100;
    }
    const integ = integrationStatus();
    const sourceChanged = newestSourceMtime();
    return {
      daemon: {
        version: VERSION,
        port: PORT,
        dataDir: DATA_DIR,
        claudePath: findClaude(),
        wtAvailable: !!s.launcher.wtPath,
        integrationInstalled: integ.mcpInstalled && integ.hooksInstalled,
        startedAt: STARTED_AT,
        sourceChangedAt: sourceChanged ? new Date(sourceChanged).toISOString() : null,
        staleCode: sourceChanged > Date.parse(STARTED_AT),
        supervised: isSupervised(),
        local: s.auth.isLocal(req),
      },
      subscriptions,
      repos: s.coord.listRepos(),
      runs: s.runs.list(),
      settings: getSettings(s.db),
      totals,
      update: s.updater.status(),
      models: s.models.list(),
    };
  };

  const requireRepo = (id: string): string => (s.coord.repoExists(id) ? id : fail(404, 'Unknown repo'));
  const num = (v: string): number => {
    const n = Number(v);
    return Number.isInteger(n) ? n : fail(400, 'Bad id');
  };

  const routes: Route[] = [];
  const route = (method: string, p: string, handler: Handler, access?: Route['access']): void => {
    const pattern = new RegExp(`^${p.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`);
    routes.push({ method, pattern, handler, access });
  };

  route('GET', '/healthz', () => ({ ok: true, version: VERSION }), 'public');

  // auth
  route('GET', '/api/auth/status', ({ req }) => s.auth.status(req), 'public');
  route('POST', '/api/auth/pair', ({ req, res, body }) => s.auth.pair(req, res, String(body.code ?? ''), String(body.name ?? '')), 'public');
  route('POST', '/api/pairing', () => s.auth.createPairingCode(), 'local');
  route('GET', '/api/devices', () => s.auth.devices(), 'local');
  route('DELETE', '/api/devices/:id', ({ params }) => (s.auth.revoke(params[0]), { ok: true }), 'local');

  // state & settings
  route('GET', '/api/state', ({ req }) => state(req));
  route('GET', '/api/settings', () => getSettings(s.db));
  route('PATCH', '/api/settings', ({ body }) => {
    const next = updateSettings(s.db, body);
    s.bus.invalidate('state');
    return next;
  });
  route('GET', '/api/integration', () => integrationStatus());
  route('POST', '/api/integration/install', async () => {
    const r = await installIntegration();
    s.bus.invalidate('state');
    return r;
  });
  route('POST', '/api/integration/uninstall', async () => {
    const r = await uninstallIntegration();
    s.bus.invalidate('state');
    return r;
  });

  // subscriptions
  route('GET', '/api/subscriptions', () => s.subs.list());
  route('POST', '/api/subscriptions', ({ body }) => s.subs.create(String(body.label ?? ''), typeof body.email === 'string' ? body.email : undefined));
  route('PATCH', '/api/subscriptions/:id', ({ params, body }) => s.subs.update(params[0], body));
  route('DELETE', '/api/subscriptions/:id', ({ params, url }) => (s.subs.remove(params[0], url.searchParams.get('purge') === '1'), { ok: true }));
  route('POST', '/api/subscriptions/:id/login', ({ params }) => (s.subs.openLogin(params[0]), { ok: true }));
  route('POST', '/api/subscriptions/:id/refresh', async ({ params }) => {
    if (!s.subs.row(params[0])) fail(404, 'not found');
    await s.subs.refreshIdentity(params[0]);
    return s.subs.get(params[0]);
  });
  route('GET', '/api/subscriptions/:id/history', ({ params, url }) => s.subs.history(params[0], Math.min(24 * 14, Number(url.searchParams.get('hours') ?? 48) || 48)));

  // repos & coordination
  route('GET', '/api/repos', () => s.coord.listRepos());
  route('POST', '/api/repos', ({ body }) => {
    const p = String(body.path ?? '');
    if (!p || !fs.existsSync(p)) fail(400, 'Directory not found');
    return s.coord.addRepo(p);
  });
  // Must precede /api/repos/:id, which would otherwise capture "discovered".
  route('GET', '/api/repos/discovered', ({ url }) => s.scanner.list(url.searchParams.get('refresh') === '1'));
  route('GET', '/api/repos/:id', ({ params }) => s.coord.repoDetail(params[0]) ?? fail(404, 'Unknown repo'));
  route('POST', '/api/repos/:id/messages', ({ params, body }) => {
    const text = String(body.body ?? '').trim();
    if (!text) fail(400, 'body is required');
    const kind = ['info', 'question', 'request', 'handoff', 'warning'].includes(body.kind) ? body.kind : 'request';
    const replyTo = typeof body.replyTo === 'number' ? body.replyTo : null;
    return s.coord.send('human', requireRepo(params[0]), body.to ?? null, kind, text, true, replyTo);
  });
  route('POST', '/api/repos/:id/read', ({ params }) => (s.coord.markHumanRead(requireRepo(params[0])), { ok: true }));
  route('POST', '/api/repos/:id/notes', ({ params, body }) => {
    const text = String(body.body ?? '').trim();
    if (!text) fail(400, 'body is required');
    const kind = ['decision', 'fact', 'warning', 'todo'].includes(body.kind) ? body.kind : 'fact';
    return s.coord.note(null, requireRepo(params[0]), kind, text, body.pinned === true);
  });
  route('PATCH', '/api/notes/:id', ({ params, body }) => (s.coord.updateNote(num(params[0]), body), { ok: true }));
  route('DELETE', '/api/claims/:id', ({ params }) => (s.coord.releaseClaim(num(params[0])), { ok: true }));
  route('POST', '/api/conflicts/:id', ({ params, body }) => {
    const status = body.status === 'dismissed' ? 'dismissed' : 'resolved';
    s.coord.resolveConflict(num(params[0]), status);
    return { ok: true };
  });

  // runs
  route('GET', '/api/runs', () => s.runs.list());
  route('POST', '/api/runs', ({ body }) => {
    if (typeof body.cwd !== 'string' || !body.cwd) fail(400, 'cwd is required');
    return s.runs.create({
      cwd: body.cwd,
      subscriptionId: typeof body.subscriptionId === 'string' ? body.subscriptionId : 'auto',
      name: typeof body.name === 'string' ? body.name : undefined,
      worktree: typeof body.worktree === 'string' ? body.worktree : undefined,
      resumeSessionId: typeof body.resumeSessionId === 'string' && body.resumeSessionId ? body.resumeSessionId : undefined,
      autoSwap: body.autoSwap !== false,
      args: Array.isArray(body.args) ? body.args.filter((a: unknown): a is string => typeof a === 'string') : undefined,
      // undefined means "fall back to the configured default"; null means "no model override".
      model: body.model === undefined ? undefined : typeof body.model === 'string' && body.model ? body.model : null,
      autoCompact: typeof body.autoCompact === 'boolean' ? body.autoCompact : undefined,
      autoCompactTokens: typeof body.autoCompactTokens === 'number' ? body.autoCompactTokens : undefined,
      skipPermissions: typeof body.skipPermissions === 'boolean' ? body.skipPermissions : undefined,
    });
  });
  route('POST', '/api/runs/:id/swap', ({ params, body }) =>
    s.runs.swap(params[0], typeof body.subscriptionId === 'string' ? body.subscriptionId : 'auto', 'manual switch', { force: body.force === true }),
  );
  route('POST', '/api/runs/:id/restart', ({ params, body }) => s.runs.restart(params[0], 'manual restart', body.force === true));
  route('POST', '/api/runs/:id/stop', ({ params }) => (s.runs.stop(params[0]), { ok: true }));
  route('DELETE', '/api/runs/:id', ({ params }) => (s.runs.forget(params[0]), { ok: true }));
  route('GET', '/api/sessions/recent', ({ url }) => s.runs.recentSessions(url.searchParams.get('cwd') ?? fail(400, 'cwd is required')));

  // automatic start (desk only: it registers a task for the logged-in user)
  route('GET', '/api/service', () => serviceStatus(), 'local');
  route('POST', '/api/service/install', async ({ body }) => {
    const s = await installService(typeof body.delaySeconds === 'number' ? body.delaySeconds : 20);
    await startService();
    s.installed = true;
    return s;
  }, 'local');
  route('POST', '/api/service/uninstall', () => uninstallService(), 'local');
  route(
    'POST',
    '/api/service/restart',
    ({ res }) => {
      if (!isSupervised()) fail(409, 'No supervisor is installed, so the daemon would not come back. Install automatic start first.');
      // Answer before exiting; the supervisor relaunches within ~10 seconds.
      json(res, 200, { ok: true, restarting: true });
      setTimeout(() => process.exit(0), 250);
      return undefined;
    },
    'local',
  );

  // claude version
  route('GET', '/api/update', () => s.updater.status());
  route('POST', '/api/update/check', () => s.updater.check(true));
  route('POST', '/api/update/restart-sessions', () => ({ queued: s.runs.restartAll(`claude ${s.updater.currentVersion ?? 'latest'}`) }));

  // models
  route('GET', '/api/models', () => s.models.list());
  route('POST', '/api/models/refresh', async () => {
    const m = await s.models.refresh();
    s.bus.invalidate('state');
    return m;
  });

  // hooks (Claude Code → daemon, desk only)
  route(
    'POST',
    '/hooks/:event',
    ({ params, body, req }) => hook(params[0], body, req.headers['x-switchboard-run'] as string | undefined),
    'local',
  );

  const serveStatic = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const index = path.join(WEB_DIST, 'index.html');
    if (!fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><title>Switchboard</title><body style="font-family:system-ui;padding:2rem;background:#0f1115;color:#e6e6e6">' +
          '<h1>Switchboard daemon is running</h1><p>The web UI is not built. Run <code>npm run build</code>, or start everything with <code>aspire run</code>.</p></body>',
      );
      return;
    }
    let file = path.normalize(path.join(WEB_DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = index;
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': file === index ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/hooks/') || url.pathname === '/healthz';
      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed');
        serveStatic(req, res, url);
        return;
      }
      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) fail(404, 'Not found');
      if (req.method !== 'GET' && !s.auth.originOk(req)) fail(403, 'Cross-origin request refused');
      if (match!.access === 'local' && !s.auth.isLocal(req)) fail(403, 'Only available on the desk itself');
      if (!match!.access && !s.auth.allowed(req)) fail(401, 'Pair this device first');
      const params = (url.pathname.match(match!.pattern) ?? []).slice(1).map(decodeURIComponent);
      const body = await readBody(req);
      const out = await match!.handler({ req, res, params, url, body });
      if (!res.headersSent) json(res, 200, out);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) log.error(`${req.method} ${url.pathname}`, err);
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    }
  });

  // ------------------------------------------------------------ websockets
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  server.on('close', () => clearInterval(heartbeat));

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const reject = (code: number, text: string): void => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const internal = url.pathname === '/ws/agent' || url.pathname === '/ws/runner';
    if (internal && (!s.auth.isLocal(req) || req.headers.origin)) return reject(403, 'Forbidden');
    if (!internal && (!s.auth.originOk(req) || !s.auth.allowed(req))) return reject(401, 'Unauthorized');
    const termMatch = url.pathname.match(/^\/ws\/term\/([a-f0-9]+)$/);
    if (!internal && url.pathname !== '/ws/ui' && !termMatch) return reject(404, 'Not Found');

    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      ws.on('error', () => ws.terminate());
      if (url.pathname === '/ws/agent') s.hub.attach(ws);
      else if (url.pathname === '/ws/runner') s.runs.attachRunner(ws);
      else if (termMatch) s.runs.attachViewer(termMatch[1], ws);
      else {
        const listener = (frame: unknown): void => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
        };
        s.bus.on('ui', listener);
        ws.on('close', () => s.bus.off('ui', listener));
      }
    });
  });

  return server;
}
