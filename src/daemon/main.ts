import type { Server } from 'node:http';
import { BIND_HOSTS, DATA_DIR, PORT, VERSION, ensureDirs } from '../config.ts';
import { logger } from '../log.ts';
import { AgentHub } from './agents.ts';
import { Auth } from './auth.ts';
import { Bus } from './bus.ts';
import { findClaude } from './claude.ts';
import { Coordinator } from './coord.ts';
import { Db } from './db.ts';
import { Launcher } from './launcher.ts';
import { RunManager } from './runs.ts';
import { createServer } from './server.ts';
import { SubscriptionManager } from './subscriptions.ts';

const log = logger('daemon');

export async function startDaemon(): Promise<void> {
  ensureDirs();
  const db = new Db();
  const bus = new Bus();
  const launcher = new Launcher();
  const coord = new Coordinator(db, bus);
  const subs = new SubscriptionManager(db, bus, launcher);
  const runs = new RunManager(db, bus, subs, coord, launcher);
  const hub = new AgentHub(coord, runs);
  coord.setPushTarget(hub);
  const auth = new Auth(db);

  runs.start();
  subs.start();
  const sweep = setInterval(() => coord.sweep(), 60_000);

  // One server per bound address: loopback for the desk's own hooks/shims/runners, plus any
  // extra address (a Tailscale IP, say) for direct remote access. They share all state.
  const servers: Server[] = [];
  for (const host of BIND_HOSTS) {
    const server = createServer({ db, bus, coord, subs, runs, auth, launcher, hub });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') log.error(`${host}:${PORT} is already in use — is another Switchboard daemon running? Set SWITCHBOARD_PORT to change it.`);
      else if (err.code === 'EADDRNOTAVAIL') log.error(`Cannot bind ${host}: no interface has that address. Check SWITCHBOARD_BIND.`);
      else log.error('server error', err);
      process.exit(1);
    });
    server.listen(PORT, host, () => log.info(`Switchboard ${VERSION} listening on http://${host}:${PORT}`));
    servers.push(server);
  }
  log.info(`data: ${DATA_DIR}`);
  log.info(`claude: ${findClaude() ?? 'NOT FOUND on PATH'}; terminal: ${launcher.wtPath ?? 'fallback'}`);

  const shutdown = (): void => {
    log.info('shutting down');
    clearInterval(sweep);
    subs.stop();
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    try {
      db.raw.close();
    } catch {
      // already closed
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
