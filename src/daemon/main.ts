import type { Server } from 'node:http';
import { BIND_HOSTS, DATA_DIR, PORT, VERSION, ensureDirs } from '../config.ts';
import { logger } from '../log.ts';
import { AgentHub } from './agents.ts';
import { Auth } from './auth.ts';
import { Bus } from './bus.ts';
import { findClaude } from './claude.ts';
import { Coordinator } from './coord.ts';
import { Db } from './db.ts';
import { RepoScanner } from './discovery.ts';
import { Launcher } from './launcher.ts';
import { getSettings } from './settings.ts';
import { ModelCatalog } from './models.ts';
import { RunManager } from './runs.ts';
import { createServer } from './server.ts';
import { SubscriptionManager } from './subscriptions.ts';
import { Updater } from './updater.ts';

const log = logger('daemon');

export async function startDaemon(): Promise<void> {
  ensureDirs();
  const db = new Db();
  const bus = new Bus();
  const launcher = new Launcher();
  const coord = new Coordinator(db, bus);
  const subs = new SubscriptionManager(db, bus, launcher);
  const models = new ModelCatalog(() => subs.anyReadyToken());
  const scanner = new RepoScanner(() => getSettings(db).repoRoots);
  const runs = new RunManager(db, bus, subs, coord, launcher, models);
  const hub = new AgentHub(coord, runs);
  coord.setPushTarget(hub);
  const auth = new Auth(db);
  const updater = new Updater(db, bus, runs);
  runs.versionProvider = () => updater.currentVersion;

  runs.start();
  subs.start();
  updater.start();
  void models.refresh();
  const sweep = setInterval(() => coord.sweep(), 60_000);

  // One server per bound address: loopback for the desk's own hooks/shims/runners, plus any
  // extra address (a Tailscale IP, say) for direct remote access. They share all state.
  const servers: Server[] = [];
  for (const host of BIND_HOSTS) {
    const server = createServer({ db, bus, coord, subs, runs, auth, launcher, hub, updater, models, scanner });
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
    updater.stop();
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
