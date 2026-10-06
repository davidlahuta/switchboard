import type { Server } from 'node:http';
import { ensureYouShouldKnow } from './plugins.ts';
import { startStallWatch } from './stalls.ts';
import { BIND_HOSTS, DATA_DIR, HOME_CLAUDE_DIR, PORT, VERSION, ensureDirs } from '../config.ts';
import { logger } from '../log.ts';
import { AgentHub } from './agents.ts';
import { Auth } from './auth.ts';
import { Bus } from './bus.ts';
import { findClaude } from './claude.ts';
import { repairTerminalWindows } from './focus.ts';
import { Coordinator } from './coord.ts';
import { Db } from './db.ts';
import { RepoScanner } from './discovery.ts';
import { repairIntegration } from './integration.ts';
import { Launcher } from './launcher.ts';
import { getSettings } from './settings.ts';
import { ModelCatalog } from './models.ts';
import { ensureNormalPriority } from './priority.ts';
import { runNewSessionTool } from './newSessionTool.ts';
import { RunManager } from './runs.ts';
import { createServer } from './server.ts';
import { SubscriptionManager } from './subscriptions.ts';
import { TranscriptWatch } from './transcriptWatch.ts';
import { Presence, questionOnScreen, SessionAlerts } from './alerts.ts';
import { PushService } from './push.ts';
import { lastAssistantText } from './tasknotes.ts';
import { Updater } from './updater.ts';
import { DeskManager } from './desks.ts';
import { Vault } from './vault.ts';
import type { DeskRepoInfo } from './coord.ts';
import { toolStatus } from '../desk/tools.ts';
import { originOf } from '../git.ts';
import { type DeskRepo, type DeskTools, remoteKey } from '../shared/desk.ts';

const log = logger('daemon');

/**
 * How often every live session's transcript is looked at. A look is a stat per session unless the
 * file grew, so this costs next to nothing, and it bounds how long a lost hook can leave a status
 * wrong: an Esc shows as idle, and a finished shell drops off, within this.
 */
const TRANSCRIPT_POLL_MS = 3000;
/** How often sessions are looked at for something to notify about; well inside the settle times in alerts.ts. */
const ALERT_TICK_MS = 2000;

export async function startDaemon(): Promise<void> {
  /*
   * The daemon is nobody's session, whatever started it.
   *
   * Switchboard is developed from inside Switchboard, so the daemon is routinely restarted from a
   * hosted session's own shell and inherits that session's run id. Every claude it then starts for
   * its own housekeeping carried the id too, and each of those is a conversation of its own for a
   * second — long enough to report itself as that run and take its place. withoutParentSession
   * strips it at each spawn; this makes sure there is nothing left to strip, for anything the
   * daemon starts by some other route.
   */
  delete process.env.SWITCHBOARD_RUN_ID;
  // Before anything that has to be quick: see ensureNormalPriority.
  ensureNormalPriority();
  ensureDirs();
  const db = new Db();
  const bus = new Bus();
  const launcher = new Launcher();
  const coord = new Coordinator(db, bus);
  const subs = new SubscriptionManager(db, bus, launcher);
  const models = new ModelCatalog(() => subs.anyReadyToken());
  const scanner = new RepoScanner(() => getSettings(db).repoRoots);
  const runs = new RunManager(db, bus, subs, coord, launcher, models);
  // The hub's own desk and the satellites paired to it; see DeskManager.
  let localTools: DeskTools | null = null;
  const refreshTools = (): void => void toolStatus(!!launcher.wtPath).then((t) => (localTools = t), () => undefined);
  const desks = new DeskManager(db, bus, {
    liveRuns: (id) => runs.liveOnDesk(id),
    runsOn: (id) => runs.runsOnDesk(id),
    loginFile: (runId) => runs.loginFile(runId),
    seed: () => subs.profileSeed(),
    localTools: () => localTools,
    localRepoRoots: () => getSettings(db).repoRoots,
    scanLocal: async () => {
      const out: DeskRepo[] = [];
      for (const r of await scanner.list(true)) {
        if (r.isWorktree) continue;
        const url = await originOf(r.path);
        out.push({ path: r.path, remoteKey: remoteKey(url), remoteUrl: url, name: r.name, branch: r.branch });
      }
      return out;
    },
  });
  runs.desks = desks;
  const vault = new Vault(db, bus);
  runs.vault = vault;
  void vault.refreshSnapshot();
  void desks.detectHubUrl();
  /*
   * A satellite's folders are asked about on that satellite. Answers are kept for a minute, and the
   * last one is used while the desk cannot be reached, so a session on a desk that drops off for a
   * moment is not filed under a board of its own in the meantime.
   */
  const deskRepoCache = new Map<string, { info: DeskRepoInfo; at: number }>();
  coord.setRepoResolver(async (dir, deskId) => {
    const key = `${deskId}|${dir.toLowerCase()}`;
    const hit = deskRepoCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.info;
    try {
      const info = await desks.rpc<DeskRepoInfo>(deskId, 'resolveRepo', { dir }, 10_000);
      deskRepoCache.set(key, { info, at: Date.now() });
      return info;
    } catch {
      return hit?.info ?? { root: dir, worktree: dir, branch: null, isGit: false };
    }
  });
  coord.setDeskPath((id) => desks.pathOf(id));
  coord.setDeskPresent((id) => desks.settled(id));
  const hub = new AgentHub(coord, runs);
  coord.setPushTarget(hub);
  coord.setSessionGone((sessionId) => runs.sessionOver(sessionId));
  coord.setRunName((runId) => runs.row(runId)?.name ?? null);
  coord.setHandedOver((runId, from, messageId) => runs.watchHandoff(runId, from, messageId));
  coord.setSessionStarter(async (caller, args) => {
    const { run, text } = await runNewSessionTool(args, { ...caller, deskId: caller.desk_id, pathOf: (id) => desks.pathOf(id) }, {
      settings: () => getSettings(db),
      subscriptions: () => subs.list().map((s) => ({ id: s.id, label: s.label, ready: s.status === 'ready' })),
      desks: () => desks.list().map((d) => ({ id: d.id, name: d.name })),
      create: (req) => runs.create(req),
    });
    log.info('an agent started a session', { by: caller.name, run: run.id, name: run.name, cwd: run.cwd });
    return { runId: run.id, text };
  });
  coord.setWorkSwept((sessionId) => runs.onWorkSettled(sessionId));
  // The transcripts, read back to catch what the hooks miss; see TranscriptWatch.
  // Notifications to phones and browsers that asked for them; see SessionAlerts.
  const push = new PushService(db);
  const presence = new Presence();
  const alerts = new SessionAlerts(
    {
      runs: () => runs.list(),
      question: (id) => questionOnScreen(runs.screenOf(id)),
      lastWords: (id) => {
        const file = runs.transcriptOf(id);
        return file ? lastAssistantText(file) : null;
      },
      quiet: () => presence.atDesktop(),
    },
    push,
  );
  const watch = new TranscriptWatch(coord, runs, () => [...new Set([HOME_CLAUDE_DIR, ...subs.list().map((s) => s.configDir), ...desks.mirrorHomes()])]);
  const auth = new Auth(db);
  const updater = new Updater(db, bus, runs);
  runs.versionProvider = () => updater.currentVersion;
  updater.desks = desks;

  // An installation from an older build is missing whatever hooks this one added; a session
  // started before that is repaired would report nothing about its subagents.
  void repairIntegration().then(
    (added) => {
      // Profiles carry their own copy of the settings, so the repair is only half done until they
      // have it: a session runs under a profile, not under the home directory.
      subs.syncAllProfiles();
      if (added.length) bus.toast('info', `Claude Code integration updated: now also watching ${added.join(', ')}.`);
    },
    (err) => log.warn('could not update the Claude Code integration', err instanceof Error ? err.message : err),
  );

  runs.start();
  subs.start();
  updater.start();
  desks.start();
  /*
   * Not at once, and one after another. The daemon's first seconds are spent reattaching every
   * session, and each one registering asks git where it is with a five-second budget. A scan of
   * every repository, a remote read for every board and a round of tool checks fired into that
   * burst made git miss its budget for six sessions, which were filed as boards of their own
   * (see mergeStrayBoards). A minute in, the desk is quiet and the answers are real.
   */
  setTimeout(() => {
    void (async () => {
      await coord.mergeStrayBoards().catch((err) => log.warn('could not fold stray boards', err instanceof Error ? err.message : err));
      await coord.backfillRemotes().catch((err) => log.warn('could not read the remotes of existing boards', err instanceof Error ? err.message : err));
      await desks.scanLocal().catch(() => undefined);
      refreshTools();
      await ensureYouShouldKnow().catch(() => undefined);
    })();
  }, 60_000).unref?.();
  // What this desk has and can do changes rarely; looked at again every ten minutes.
  const deskUpkeep = setInterval(() => {
    refreshTools();
    void desks.scanLocal().catch(() => undefined);
  }, 10 * 60_000);
  void models.refresh();
  const sweep = setInterval(() => coord.sweep(), 60_000);
  const transcripts = setInterval(() => watch.poll(), TRANSCRIPT_POLL_MS);
  const notify = setInterval(() => alerts.tick(), ALERT_TICK_MS);
  // A terminal window stranded off screen sizes every tab opened in it to 54x1; see repairTerminalWindows.
  repairTerminalWindows();
  const windows = setInterval(repairTerminalWindows, 5 * 60_000);
  watch.poll();
  // Retention runs far less often than the liveness sweep: it is a bulk delete, and an hour of
  // extra history costs nothing next to doing it on every pass.
  const prune = setInterval(() => {
    coord.prune();
    subs.prune();
    db.optimize();
  }, 3600_000);
  coord.prune();
  subs.prune();
  const stopStallWatch = startStallWatch();
  // /rename and /model inside a session write to disk at once and fire no hook, so an idle session
  // renamed or switched there would not show up here until someone typed something into it.
  // Every session's copy of its login kept on its subscription's newest; see CredentialSync.
  const logins = setInterval(() => void runs.syncCredentials().catch((err) => log.warn('login sync failed', err instanceof Error ? err.message : err)), 2000);
  const titles = setInterval(() => {
    runs.pollSessions();
    runs.drainPending();
    // A session whose terminal died is brought back here, on its own backoff; one whose turn failed
    // is told to carry on, on its own.
    runs.reviveDue();
    runs.resumeStalled();
  }, 4000);

  // One server per bound address: loopback for the desk's own hooks/shims/runners, plus any
  // extra address (a Tailscale IP, say) for direct remote access. They share all state.
  const servers: Server[] = [];
  for (const host of BIND_HOSTS) {
    const server = createServer({ db, bus, coord, subs, runs, auth, launcher, hub, updater, models, scanner, watch, push, presence, desks, vault });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') log.error(`${host}:${PORT} is already in use — is another Switchboard daemon running? Set SWITCHBOARD_PORT to change it.`);
      else if (err.code === 'EADDRNOTAVAIL') log.error(`Cannot bind ${host}: no interface has that address. Check SWITCHBOARD_BIND.`);
      else log.error('server error', err);
      process.exit(1);
    });
    server.listen(PORT, host, () => {
      log.info(`Switchboard ${VERSION} listening on http://${host}:${PORT}`);
      // Only now can a runner reconnect, so only now does its thirty seconds start; see armStartupRevives.
      runs.armStartupRevives();
    });
    servers.push(server);
  }
  log.info(`data: ${DATA_DIR}`);
  log.info(`claude: ${findClaude() ?? 'NOT FOUND on PATH'}; terminal: ${launcher.wtPath ?? 'fallback'}`);

  const shutdown = (): void => {
    log.info('shutting down');
    clearInterval(sweep);
    clearInterval(transcripts);
    clearInterval(notify);
    clearInterval(windows);
    clearInterval(prune);
    stopStallWatch();
    clearInterval(titles);
    clearInterval(logins);
    clearInterval(deskUpkeep);
    desks.stop();
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
