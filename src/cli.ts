import { spawn } from 'node:child_process';
import { DAEMON_URL, VERSION } from './config.ts';

const HELP = `switchboard ${VERSION} — coordination hub and subscription manager for Claude Code

Usage:
  switchboard daemon                 Start the daemon (UI + API on ${DAEMON_URL})
  switchboard run [options]          Run a Claude Code session hosted by Switchboard in this terminal
      --sub <id|auto>                Subscription to start on (default: auto)
      --name <name>                  Display name
      --resume <session-id>          Resume an existing session (its GUID)
      --cwd <dir>                    Working directory (default: current)
      --model <id>                   Model to use (switchboard status lists them)
      --no-auto-compact              Disable auto-compact for this session
      --ask-permissions              Keep permission prompts (default: skipped)
      --compact-at <tokens>          Auto-compact threshold (default from settings)
      -- <args...>                   Everything after a bare -- is passed to claude
  switchboard mcp                    Stdio MCP server (spawned by Claude Code)
  switchboard desk join <hub> <code> Join this machine to a hub as a satellite desk
      --name <name>                  How the hub shows it (default: the computer name)
      --port <n>                     Local port sessions talk to (default 4477)
  switchboard desk                   Run the desk agent (sessions here are hosted by the hub)
  switchboard desk status            Show which hub this desk belongs to and whether it answers
  switchboard service install --desk Start the desk agent automatically at logon instead of a daemon
  switchboard install                Register the MCP server + hooks globally for all sessions
  switchboard uninstall              Remove the global registration
  switchboard service install        Start the daemon automatically at logon (Windows)
      --delay <seconds>              Wait this long after logon (default 20)
  switchboard service uninstall      Remove the automatic start
  switchboard service status         Show the scheduled task and whether the daemon answers
  switchboard hub stop               Moving the hub: stop this daemon for good (sessions keep running)
  switchboard hub export <file>      Moving the hub: pack it into one file (--dry-run: no secrets, daemon may run)
  switchboard hub import <file>      Moving the hub: unpack it here; the old hub becomes a desk of this one
  switchboard desk set-hub <url>     Point this desk at a hub that moved
  switchboard status                 Print a short summary from the running daemon
  switchboard diag [--json]          Why every session is where it is: host, work, queued respawns
      --screen                       Show every session's screen, not only the ones asking something
`;

function flags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

const str = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

async function loginShell(f: Record<string, string | true>): Promise<void> {
  const { findClaude, claudeCommand } = await import('./daemon/claude.ts');
  const claude = findClaude();
  const label = str(f.label) ?? 'subscription';
  if (!claude) {
    console.error('claude executable not found on PATH');
    return waitForKey(1);
  }
  const env = { ...process.env };
  const dir = str(f['config-dir']);
  if (!dir || dir === 'default') delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  console.log(`\x1b[1;36m[switchboard]\x1b[0m Sign in for "${label}".`);
  console.log('Make sure the browser signs in with the account you want for this subscription');
  console.log('(use a private window, or sign out of claude.ai first).\n');
  const args = ['auth', 'login', '--claudeai'];
  const email = str(f.email);
  if (email) args.push('--email', email);
  const cmd = claudeCommand(claude, args);
  const child = spawn(cmd.file, cmd.args, { stdio: 'inherit', env });
  child.on('exit', (code) => {
    if (code === 0) {
      console.log('\n\x1b[1;32mDone.\x1b[0m Switchboard picked up the login. This tab closes in a few seconds.');
      setTimeout(() => process.exit(0), 4000);
    } else {
      console.log(`\nLogin exited with code ${code}.`);
      void waitForKey(code ?? 1);
    }
  });
}

function waitForKey(code: number): Promise<void> {
  console.log('Press any key to close.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
  return new Promise(() => {});
}

async function status(): Promise<void> {
  const res = await fetch(`${DAEMON_URL}/api/state`).catch(() => null);
  if (!res?.ok) {
    console.error(`Daemon not reachable at ${DAEMON_URL}`);
    process.exit(1);
  }
  const s = (await res.json()) as import('./shared/types.ts').StateSnapshot;
  console.log(`Switchboard ${s.daemon.version} · ${s.totals.liveRuns} live sessions · ${s.totals.agentsOnline} agents online`);
  for (const sub of s.subscriptions) {
    const u = sub.usage;
    const pct = (w: { pct: number } | null | undefined): string => (w ? `${Math.round(w.pct)}%`.padStart(4) : '   ?');
    console.log(`  ${sub.enabled ? '●' : '○'} ${sub.label.padEnd(28)} ${sub.status.padEnd(13)} 5h ${pct(u?.fiveHour)}  7d ${pct(u?.sevenDay)}  ${sub.email ?? ''}`);
  }
  for (const r of s.repos.filter((x) => x.agentsOnline > 0)) console.log(`  ${r.name}: ${r.agentsOnline} agent(s), ${r.openConflicts} open conflict(s)`);
  if (s.models.length) {
    const mark = (id: string): string => (id === s.settings.defaultModel ? ' (default)' : '');
    console.log(`Models (>=1M context): ${s.models.map((m) => m.id + mark(m.id)).join(', ')}`);
  }
  console.log(`claude ${s.update.currentVersion ?? '?'}${s.update.lastError ? ` · update issue: ${s.update.lastError}` : ''}`);
}

/**
 * One block per live session: what hosts it, what it is doing, what is queued for it and what that
 * waits on. Anything that needs a person is in capitals, so a glance down the left margin finds it.
 */
async function diag(asJson: boolean, screen: boolean): Promise<void> {
  const res = await fetch(`${DAEMON_URL}/api/diagnostics`).catch(() => null);
  if (!res?.ok) {
    console.error(`Daemon not reachable at ${DAEMON_URL}${res ? ` (HTTP ${res.status})` : ''}`);
    process.exit(1);
  }
  const d = (await res.json()) as import('./daemon/server.ts').Diagnostics;
  if (asJson) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  const dur = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
  const since = (iso: string | null): string => (iso ? `${dur(Date.now() - Date.parse(iso))} ago` : '—');
  const k = d.daemon;
  console.log(
    `daemon ${k.version} pid ${k.pid} · up ${dur(k.uptimeS * 1000)} · ${k.rssMb} MB · claude ${k.claude ?? '?'}` +
      `${k.staleCode ? ' · CODE CHANGED SINCE START' : ''}${k.supervised ? '' : ' · not supervised'}`,
  );
  for (const r of d.runs) {
    const notes: string[] = [];
    if (!r.runner.attached) notes.push('RUNNER NOT ATTACHED');
    if (r.claude.pid !== null && !r.claude.alive) notes.push(`CLAUDE ${r.claude.pid} GONE`);
    if (r.agent && r.claude.pid !== null && r.agent.pid !== r.claude.pid) notes.push(`BOARD HAS PID ${r.agent.pid}`);
    if (r.stalled) notes.push(`STALLED: ${r.stalled.reason ?? 'unknown'}`);
    if (r.revive) notes.push(`REVIVE try ${r.revive.tries}${r.revive.after ? ` due ${r.revive.after.slice(11, 19)}Z` : ''}`);
    if (r.runner.stale) notes.push('old host');
    if (r.runner.relaunching) notes.push('relaunching');
    console.log(`\n${r.name}  [${r.run.slice(0, 8)}]  ${r.status} · agent ${r.agent?.status ?? '—'}, seen ${since(r.agent?.lastSeen ?? null)} · session ${r.session.slice(0, 8)} · ${r.subscription}`);
    console.log(`  runner up ${since(r.runner.startedAt)} · claude ${r.claude.pid ?? '—'}${notes.length ? ` · ${notes.join(' · ')}` : ''}`);
    if (r.queued) {
      const q = r.queued;
      const where = `${q.kind === 'swap' ? ` → ${q.target}` : ''}${q.fresh ? ', new terminal' : ''}`;
      const state = q.ready ? 'ready, taken within seconds' : `waiting on ${q.holding}`;
      console.log(`  queued ${q.kind} (${q.trigger})${where} for ${dur(q.waitedMs)} · ${state}${q.deadline ? ` · deadline ${q.deadline.slice(11, 19)}Z` : ''}`);
    }
    for (const w of r.work) console.log(`  ${w.kind.padEnd(8)} ${(w.label ?? '').slice(0, 58).padEnd(58)} started ${since(w.since)}, silent ${dur(w.silentMs)}`);
    // A session asking something shows the question: "waiting" alone cannot be acted on.
    if (screen || r.agent?.status === 'waiting' || r.stalled) {
      if (!r.screen.length) console.log('  screen   (nothing drawn since the daemon started)');
      for (const line of r.screen) console.log(`  │ ${line.slice(0, 110)}`);
    }
  }
  // Boards: what the sweeps keep tidy, in capitals when they are not keeping up.
  for (const b of d.boards ?? []) {
    if (!b.agentsLive && !b.conflicts.open && !b.questions.owed) continue;
    const o = b.orphans;
    const orphans = o.claimsOfLeftAgents + o.expiredClaimsOpen + o.messagesStrandedOnLeftAgents + o.lanesOfLeftAgents;
    console.log(`\nboard ${b.repoName} · ${b.agentsLive} live · ${b.claims.open} claims (${b.claims.exclusive} exclusive, ${b.claims.inLanes} in ${b.lanes} lanes) · ${b.notes.pinned}/${b.notes.active} notes pinned`);
    const closed = Object.entries(b.conflicts.closedWhy).map(([why, n]) => `${n} ${why}`).join(', ');
    console.log(`  conflicts ${b.conflicts.open} open, ${b.conflicts.closed24h} closed today${closed ? ` (${closed})` : ''} · questions ${b.questions.owed} owed, ${b.questions.lapsed24h} lapsed today`);
    if (orphans) {
      console.log(
        `  ORPHANS: ${o.claimsOfLeftAgents} claims of agents that left · ${o.expiredClaimsOpen} expired claims open · ${o.messagesStrandedOnLeftAgents} messages stranded · ${o.lanesOfLeftAgents} lanes of agents that left`,
      );
    }
    for (const t of b.traffic24h.slice(0, 12)) {
      console.log(`  ${t.name.slice(0, 28).padEnd(28)} ${t.status.padEnd(9)} sent ${String(t.sent).padStart(4)} (${t.broadcasts} to all) · got ${String(t.received).padStart(4)}, ${Math.round(t.chars / 1000)}k chars`);
    }
    for (const u of b.upkeep24h.slice(0, 5)) console.log(`  upkeep ${u.ts.slice(11, 19)}Z ${u.summary.slice(0, 100)}`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  switch (cmd) {
    case 'daemon':
      return (await import('./daemon/main.ts')).startDaemon();
    case 'mcp':
      return (await import('./mcp/shim.ts')).runShim();
    case 'run': {
      // Set before the runner connects: config read SWITCHBOARD_URL when this process started.
      const daemon = str(f.daemon);
      if (daemon) process.env.SWITCHBOARD_URL = daemon;
      const { runRunner } = await import('./runner/runner.ts');
      const runId = str(f['run-id']);
      // Everything after a bare `--` goes to claude untouched.
      const sep = rest.indexOf('--');
      const passthrough = sep === -1 ? [] : rest.slice(sep + 1);
      const compactAt = Number(str(f['compact-at']));
      return runRunner(
        runId
          ? { runId }
          : {
              manual: {
                cwd: str(f.cwd) ?? process.cwd(),
                subscriptionId: str(f.sub) ?? 'auto',
                name: str(f.name),
                resumeSessionId: str(f.resume),
                model: str(f.model) ?? undefined,
                autoCompact: f['no-auto-compact'] ? false : undefined,
                skipPermissions: f['ask-permissions'] ? false : undefined,
                autoCompactTokens: Number.isFinite(compactAt) && compactAt > 0 ? compactAt : undefined,
                args: passthrough.length ? passthrough : undefined,
              },
            },
      );
    }
    case 'desk': {
      const desk = await import('./desk/agent.ts');
      const sub = rest.find((a) => !a.startsWith('--'));
      if (sub === 'join') {
        const [, hub, code] = rest.filter((a) => !a.startsWith('--'));
        if (!hub || !code) {
          console.error('Usage: switchboard desk join <hub-url> <code>   (the hub shows both under Settings → Desks)');
          process.exit(1);
        }
        const port = Number(str(f.port));
        const cfg = await desk.joinDesk(hub, code, { name: str(f.name), port: Number.isInteger(port) && port > 0 ? port : undefined });
        console.log(`Joined ${cfg.hub} as desk ${cfg.name ?? cfg.deskId}.`);
        console.log(`Config: ${desk.DESK_CONFIG}${cfg.tokenProtected ? ' (token sealed with DPAPI)' : ''}`);
        console.log('Next: `node src/cli.ts service install --desk` to start the agent at every logon, or `node src/cli.ts desk` to run it now.');
        return;
      }
      if (sub === 'set-hub') {
        const [, hub] = rest.filter((a) => !a.startsWith('--'));
        const cfg = desk.readDeskConfig();
        if (!hub || !cfg) {
          console.error(cfg ? 'Usage: switchboard desk set-hub <hub-url>' : 'Not joined to a hub; use desk join.');
          process.exit(1);
        }
        desk.saveDeskConfig({ ...cfg, hub: hub.replace(/\/+$/, '') });
        console.log(`This desk now connects to ${hub}. A running agent moves there the next time it reconnects; to move it now, restart it (service status --desk shows how it runs).`);
        return;
      }
      if (sub === 'status') {
        const cfg = desk.readDeskConfig();
        if (!cfg) {
          console.log('Not joined to a hub.');
          return;
        }
        const res = await fetch(`http://127.0.0.1:${cfg.port}/healthz`).catch(() => null);
        const body = res?.ok ? ((await res.json()) as { hub?: boolean }) : null;
        console.log(`desk ${cfg.name ?? cfg.deskId} · hub ${cfg.hub} · agent ${body ? 'running' : 'NOT RUNNING'}${body ? ` · hub ${body.hub ? 'connected' : 'NOT CONNECTED'}` : ''}`);
        return;
      }
      return desk.runDeskAgent();
    }
    case 'login-shell':
      return loginShell(f);
    // git's credential helper and the gh/az shims; see src/desk/credential.ts.
    case 'credential':
      return (await import('./desk/credential.ts')).gitCredentialHelper(rest[0] ?? '');
    case 'cred-exec': {
      const [tool, ...toolArgs] = rest;
      return (await import('./desk/credential.ts')).credExec(tool ?? '', toolArgs);
    }
    case 'install': {
      const s = await (await import('./daemon/integration.ts')).installIntegration();
      console.log(`MCP server: ${s.mcpInstalled ? 'registered' : 'FAILED'} · hooks: ${s.hooksInstalled ? 'installed' : 'FAILED'}`);
      return;
    }
    case 'uninstall': {
      const s = await (await import('./daemon/integration.ts')).uninstallIntegration();
      console.log(`MCP server: ${s.mcpInstalled ? 'still registered' : 'removed'} · hooks: ${s.hooksInstalled ? 'still present' : 'removed'}`);
      return;
    }
    case 'hub': {
      const h = await import('./daemon/handover.ts');
      const [sub, arg] = rest.filter((a) => !a.startsWith('--'));
      if (sub === 'stop') {
        for (const line of await h.stopHub()) console.log(line);
        console.log('The daemon is stopped and will not start again here. Sessions keep running; their terminals reconnect to whatever listens on 127.0.0.1 next.');
        return;
      }
      if (sub === 'export') {
        if (!arg) {
          console.error('Usage: switchboard hub export <file> [--dry-run]');
          process.exit(1);
        }
        const r = await h.exportHub(arg, { dryRun: f['dry-run'] === true });
        console.log(`Wrote ${r.file}: ${r.subscriptions} subscription(s), ${r.runs} live session(s), ${r.logins} session login(s), ${r.secrets} credential secret(s).`);
        console.log(f['dry-run'] === true ? 'Dry run: no logins or secrets in it, for trying the import.' : 'It holds every login and secret in the clear: copy it to the new hub, import it, delete it.');
        return;
      }
      if (sub === 'import') {
        if (!arg) {
          console.error('Usage: switchboard hub import <file> [--name <name for the old hub>] [--force]');
          process.exit(1);
        }
        const r = await h.importHub(arg, { force: f.force === true, name: str(f.name) });
        if (r.backup) console.log(`The database that was here is kept as ${r.backup}.`);
        console.log(`Imported ${r.subscriptions} subscription(s). The old hub is now the desk "${r.deskName}" (${r.deskId}) with ${r.runs} live session(s) waiting for it.`);
        for (const n of r.notes) console.log(`! ${n}`);
        if (r.dryRun) console.log('Dry run: nothing is revived, restarted or updated by this hub.');
        console.log('Next, here: start the daemon (node src/cli.ts service install).');
        console.log(`Then on the old hub, within a week:\n  node src/cli.ts desk join ${process.env.SWITCHBOARD_HUB_URL ?? '<this hub\'s URL>'} ${r.code}\n  node src/cli.ts service install --desk`);
        return;
      }
      console.error('Usage: switchboard hub stop | export <file> [--dry-run] | import <file> [--name <n>] [--force]');
      process.exit(1);
    }
    case 'service': {
      const svc = await import('./daemon/service.ts');
      const sub = rest.find((a) => !a.startsWith('--')) ?? 'status';
      // --desk: this machine is a satellite, and the task keeps its desk agent running instead.
      const role = f.desk === true ? 'desk' : 'daemon';
      if (sub === 'install') {
        const s = await svc.installService(Number(str(f.delay) ?? 20), role);
        if (process.platform === 'linux') {
          console.log(`systemd user unit ${svc.taskName(role)} installed, enabled and started (${s.state ?? 'state unknown'}).`);
        } else {
          await svc.startService(role);
          console.log(`Scheduled task "${svc.taskName(role)}" installed and started.`);
          console.log('Note: it starts at logon, because opening terminal tabs needs an interactive desktop.');
        }
        console.log(`Log: ${s.logPath}`);
        for (const n of svc.lastInstallNotes()) console.log(`! ${n}`);
        return;
      }
      if (sub === 'uninstall') {
        await svc.uninstallService(role);
        console.log('Automatic start removed.');
        return;
      }
      const s = await svc.serviceStatus(role);
      console.log(`installed: ${s.installed}${s.state ? ` (${s.state})` : ''}`);
      console.log(`daemon responding: ${s.running}`);
      if (s.lastRunTime) console.log(`last run: ${s.lastRunTime} (result ${s.lastResult})`);
      console.log(`log: ${s.logPath}`);
      return;
    }
    case 'status':
      return status();
    case 'diag':
      return diag(f.json === true, f.screen === true);
    case 'version':
    case '--version':
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
  }
}

main().catch((err: unknown) => {
  // Moving a hub is done by hand, step by step: what went wrong, said plainly, is the useful part.
  const plain = process.argv[2] === 'hub';
  console.error(err instanceof Error ? (plain ? err.message : (err.stack ?? err.message)) : err);
  process.exit(1);
});
