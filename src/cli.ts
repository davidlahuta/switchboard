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
      --compact-at <tokens>          Auto-compact threshold (default from settings)
      -- <args...>                   Everything after a bare -- is passed to claude
  switchboard mcp                    Stdio MCP server (spawned by Claude Code)
  switchboard install                Register the MCP server + hooks globally for all sessions
  switchboard uninstall              Remove the global registration
  switchboard service install        Start the daemon automatically at logon (Windows)
      --delay <seconds>              Wait this long after logon (default 20)
  switchboard service uninstall      Remove the automatic start
  switchboard service status         Show the scheduled task and whether the daemon answers
  switchboard status                 Print a short summary from the running daemon
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

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  switch (cmd) {
    case 'daemon':
      return (await import('./daemon/main.ts')).startDaemon();
    case 'mcp':
      return (await import('./mcp/shim.ts')).runShim();
    case 'run': {
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
                autoCompactTokens: Number.isFinite(compactAt) && compactAt > 0 ? compactAt : undefined,
                args: passthrough.length ? passthrough : undefined,
              },
            },
      );
    }
    case 'login-shell':
      return loginShell(f);
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
    case 'service': {
      const svc = await import('./daemon/service.ts');
      const sub = rest.find((a) => !a.startsWith('--')) ?? 'status';
      if (sub === 'install') {
        const s = await svc.installService(Number(str(f.delay) ?? 20));
        await svc.startService();
        console.log(`Scheduled task "${svc.TASK_NAME}" installed and started.`);
        console.log(`Log: ${s.logPath}`);
        console.log('Note: it starts at logon, because opening terminal tabs needs an interactive desktop.');
        return;
      }
      if (sub === 'uninstall') {
        await svc.uninstallService();
        console.log('Automatic start removed.');
        return;
      }
      const s = await svc.serviceStatus();
      console.log(`installed: ${s.installed}${s.state ? ` (${s.state})` : ''}`);
      console.log(`daemon responding: ${s.running}`);
      if (s.lastRunTime) console.log(`last run: ${s.lastRunTime} (result ${s.lastResult})`);
      console.log(`log: ${s.logPath}`);
      return;
    }
    case 'status':
      return status();
    case 'version':
    case '--version':
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
