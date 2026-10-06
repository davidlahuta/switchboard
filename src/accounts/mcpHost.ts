import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IS_WINDOWS, PACKAGE_ROOT, SPAWN_CWD, withoutParentSession } from '../config.ts';
import { logger } from '../log.ts';
import { execFileOff, spawnOff } from '../spawnOff.ts';

const log = logger('mcp-host');

/*
 * The MCP servers Switchboard gives sessions, on the machine the session runs on (the hub for its
 * own sessions, each desk agent for its).
 *
 * - Playwright (@playwright/mcp) and Microsoft 365 (@softeria/ms-365-mcp-server) are stdio servers
 *   claude starts itself, one per session (one per account for Microsoft). All this does is install
 *   them once, at a pinned version, under the data folder, so a session never waits on npx fetching
 *   "latest" and two desks run the same code.
 * - Google Workspace (workspace-mcp, Python) runs once per machine as a loopback HTTP server in its
 *   stateless external-token mode: it holds no credentials at all, and every request carries the
 *   bearer token of the account it is for (see the headersHelper in RunManager.buildSpec). It runs on
 *   a fixed port and outlives the daemon, which adopts it again when it comes back, so sessions keep
 *   working across a daemon restart.
 *
 * Every process here is started through spawnOff: creating one never holds the event loop.
 */

export const MS365_PACKAGE = '@softeria/ms-365-mcp-server';
export const MS365_VERSION = '0.158.0';
export const PLAYWRIGHT_PACKAGE = '@playwright/mcp';
export const PLAYWRIGHT_VERSION = '0.0.83';
export const WORKSPACE_MCP_VERSION = '2.0.1';
/** Google Workspace tools sessions get (everything but Chat, Forms, Apps Script and web search). */
export const WORKSPACE_TOOLS = ['gmail', 'drive', 'calendar', 'docs', 'sheets', 'slides', 'contacts', 'tasks'];

/** Our preload for the Microsoft server: its token comes from Switchboard, see ms365-preload.mjs. */
export const MS365_PRELOAD = path.join(PACKAGE_ROOT, 'src', 'accounts', 'ms365-preload.mjs');

export interface McpToolStatus {
  playwright: { version: string | null; error: string | null };
  ms365: { version: string | null; error: string | null };
  google: { running: boolean; port: number; version: string; error: string | null; uv: boolean | null };
}

interface NpmTool {
  pkg: string;
  version: string;
  dir: string;
  /** the server's entry script, relative to the package */
  entry: string;
}

export class McpHost {
  readonly root: string;
  readonly googlePort: number;
  private readonly npm: Record<'playwright' | 'ms365', NpmTool>;
  private readonly installing = new Map<string, Promise<string | null>>();
  private readonly errors = new Map<string, string | null>();
  private uv: boolean | null = null;
  private google: { pid: number; port: number } | null = null;
  private googleStarting: Promise<boolean> | null = null;
  private googleClientId: string | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(dataDir: string, googlePort: number) {
    this.root = path.join(dataDir, 'mcp');
    this.googlePort = googlePort;
    this.npm = {
      playwright: { pkg: PLAYWRIGHT_PACKAGE, version: PLAYWRIGHT_VERSION, dir: path.join(this.root, 'playwright'), entry: 'cli.js' },
      ms365: { pkg: MS365_PACKAGE, version: MS365_VERSION, dir: path.join(this.root, 'ms365'), entry: path.join('dist', 'index.js') },
    };
  }

  // ------------------------------------------------------------ npm tools

  private packageDir(t: NpmTool): string {
    return path.join(t.dir, 'node_modules', ...t.pkg.split('/'));
  }

  /** The installed version of a tool, if it is the pinned one. */
  private installed(key: 'playwright' | 'ms365'): string | null {
    const t = this.npm[key];
    try {
      const v = (JSON.parse(fs.readFileSync(path.join(this.packageDir(t), 'package.json'), 'utf8')) as { version?: string }).version;
      return v === t.version ? v : null;
    } catch {
      return null;
    }
  }

  /** The entry script of a tool when the pinned version is installed, else null (and it is installed). */
  entry(key: 'playwright' | 'ms365'): string | null {
    if (this.installed(key)) return path.join(this.packageDir(this.npm[key]), this.npm[key].entry);
    void this.ensure(key);
    return null;
  }

  /** Install the pinned version once; concurrent callers share the install. */
  ensure(key: 'playwright' | 'ms365'): Promise<string | null> {
    if (this.installed(key)) return Promise.resolve(path.join(this.packageDir(this.npm[key]), this.npm[key].entry));
    const running = this.installing.get(key);
    if (running) return running;
    const t = this.npm[key];
    const p = (async () => {
      fs.mkdirSync(t.dir, { recursive: true });
      const manifest = path.join(t.dir, 'package.json');
      if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ name: `switchboard-${key}`, private: true }, null, 2));
      log.info('installing an MCP server', { pkg: t.pkg, version: t.version });
      try {
        await execFileOff(IS_WINDOWS ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--omit=dev', '--save-exact', `${t.pkg}@${t.version}`], {
          cwd: t.dir,
          env: withoutParentSession(),
          timeout: 10 * 60_000,
          shell: IS_WINDOWS,
          windowsHide: true,
        });
        this.errors.set(key, null);
        log.info('installed an MCP server', { pkg: t.pkg, version: t.version });
        return path.join(this.packageDir(t), t.entry);
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : String(err);
        this.errors.set(key, message);
        log.warn('could not install an MCP server', { pkg: t.pkg, error: message });
        return null;
      }
    })().finally(() => this.installing.delete(key));
    this.installing.set(key, p);
    return p;
  }

  /** This machine's paths for the entries a session's MCP file holds; null entries are not installed yet. */
  paths(url?: string): McpPaths {
    return {
      node: process.execPath,
      cli: path.join(PACKAGE_ROOT, 'src', 'cli.ts'),
      preload: pathToFileURL(MS365_PRELOAD).href,
      playwright: this.entry('playwright'),
      ms365: this.entry('ms365'),
      googlePort: String(this.googlePort),
      logs: path.join(this.root, 'logs').split(path.sep).join('/'),
      ...(url ? { url } : {}),
    };
  }

  // --------------------------------------------------------------- google

  private stateFile(): string {
    return path.join(this.root, 'google.json');
  }

  private uvToolBin(): string {
    return path.join(this.root, 'uv', 'bin', IS_WINDOWS ? 'workspace-mcp.exe' : 'workspace-mcp');
  }

  private uvEnv(): Record<string, string> {
    return { ...withoutParentSession(), UV_TOOL_DIR: path.join(this.root, 'uv', 'tools'), UV_TOOL_BIN_DIR: path.join(this.root, 'uv', 'bin') };
  }

  /** Whether the server on our port is workspace-mcp in external-token mode: it turns a tokenless request away. */
  private async answers(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: '{"jsonrpc":"2.0","id":0,"method":"ping"}',
        signal: AbortSignal.timeout(3000),
      });
      return res.status === 401 && /oauth-protected-resource/.test(res.headers.get('www-authenticate') ?? '');
    } catch {
      return false;
    }
  }

  private async installWorkspaceMcp(): Promise<string | null> {
    const bin = this.uvToolBin();
    const marker = path.join(this.root, 'uv', 'version');
    if (fs.existsSync(bin) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === WORKSPACE_MCP_VERSION) return bin;
    try {
      await execFileOff('uv', ['--version'], { timeout: 30_000, windowsHide: true, env: this.uvEnv() });
      this.uv = true;
    } catch {
      this.uv = false;
      this.errors.set('google', `uv is not installed: ${IS_WINDOWS ? 'winget install astral-sh.uv' : 'sudo pacman -S uv (or your distribution\'s uv package)'}`);
      return null;
    }
    log.info('installing the Google Workspace MCP server', { version: WORKSPACE_MCP_VERSION });
    try {
      await execFileOff('uv', ['tool', 'install', '--force', '--python-preference', 'managed', `workspace-mcp==${WORKSPACE_MCP_VERSION}`], {
        cwd: SPAWN_CWD,
        env: this.uvEnv(),
        timeout: 10 * 60_000,
        windowsHide: true,
      });
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, WORKSPACE_MCP_VERSION);
      return bin;
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : String(err);
      this.errors.set('google', message);
      log.warn('could not install the Google Workspace MCP server', { error: message });
      return null;
    }
  }

  /**
   * Make sure the Google server is up for this client ID: adopt the one already running on our port
   * (from before a daemon restart), or install and start one. Kept up by a watchdog while wanted.
   */
  ensureGoogle(clientId: string | null): Promise<boolean> {
    this.googleClientId = clientId;
    if (!clientId) {
      void this.stopGoogle();
      return Promise.resolve(false);
    }
    if (!this.watchdog) {
      this.watchdog = setInterval(() => void this.ensureGoogle(this.googleClientId), 60_000);
      this.watchdog.unref?.();
    }
    if (this.googleStarting) return this.googleStarting;
    this.googleStarting = (async () => {
      const port = this.googlePort;
      if (await this.answers(port)) {
        const saved = this.readState();
        // Started for another app: its tokens would not be accepted, so it is replaced.
        if (saved && saved.clientId !== clientId) await this.killTree(saved.pid);
        else {
          if (!this.google) log.info('the Google Workspace MCP server is already running; using it', { port, pid: saved?.pid ?? null });
          this.google = { pid: saved?.pid ?? 0, port };
          this.errors.set('google', null);
          return true;
        }
      }
      const bin = await this.installWorkspaceMcp();
      if (!bin) return false;
      const child = spawnOff(bin, ['--transport', 'streamable-http', '--tool-tier', 'complete', '--tools', ...WORKSPACE_TOOLS], {
        cwd: this.root,
        detached: true,
        ignoreOutput: true,
        env: {
          ...withoutParentSession(),
          MCP_ENABLE_OAUTH21: 'true',
          EXTERNAL_OAUTH21_PROVIDER: 'true',
          WORKSPACE_MCP_STATELESS_MODE: 'true',
          WORKSPACE_MCP_HOST: '127.0.0.1',
          WORKSPACE_MCP_PORT: String(port),
          WORKSPACE_MCP_TOKEN_VALIDATION_CACHE_TTL: '300',
          GOOGLE_OAUTH_CLIENT_ID: clientId,
          // Signs nothing we use (we never let it issue tokens), but it will not start without one.
          FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY: crypto.randomBytes(32).toString('base64url'),
        },
      });
      const pid = await new Promise<number | null>((resolve) => {
        child.on('spawned', (p: number | null) => resolve(p));
        child.on('error', (err: Error) => {
          this.errors.set('google', err.message);
          resolve(null);
        });
      });
      if (!pid) return false;
      for (let i = 0; i < 60; i++) {
        if (await this.answers(port)) {
          this.google = { pid, port };
          this.writeState({ pid, port, clientId, version: WORKSPACE_MCP_VERSION });
          this.errors.set('google', null);
          log.info('started the Google Workspace MCP server', { port, pid });
          return true;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      this.errors.set('google', 'started, but did not answer on its port within a minute');
      await this.killTree(pid);
      return false;
    })().finally(() => {
      this.googleStarting = null;
    });
    return this.googleStarting;
  }

  async stopGoogle(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const saved = this.readState();
    const pid = this.google?.pid || saved?.pid;
    this.google = null;
    if (pid) await this.killTree(pid);
    fs.rmSync(this.stateFile(), { force: true });
  }

  /** The server and everything under it (uv's launcher starts Python as a child), by process id. */
  private async killTree(pid: number): Promise<void> {
    if (!pid) return;
    try {
      if (IS_WINDOWS) await execFileOff('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
      else process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }

  private readState(): { pid: number; port: number; clientId: string; version: string } | null {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8')) as { pid: number; port: number; clientId: string; version: string };
    } catch {
      return null;
    }
  }

  private writeState(s: { pid: number; port: number; clientId: string; version: string }): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.stateFile(), JSON.stringify(s, null, 2));
  }

  status(): McpToolStatus {
    return {
      playwright: { version: this.installed('playwright'), error: this.errors.get('playwright') ?? null },
      ms365: { version: this.installed('ms365'), error: this.errors.get('ms365') ?? null },
      google: { running: !!this.google, port: this.googlePort, version: WORKSPACE_MCP_VERSION, error: this.errors.get('google') ?? null, uv: this.uv },
    };
  }
}

/** Where a session's MCP servers are on the machine it runs on. */
export interface McpPaths {
  node: string;
  cli: string;
  preload: string;
  playwright: string | null;
  ms365: string | null;
  googlePort: string;
  /** where each session's Microsoft server keeps its logs, one folder per run */
  logs: string;
  /** the Switchboard this machine's sessions talk to, when it is not the default 127.0.0.1:4477 */
  url?: string;
}

/**
 * The same, for a session on a satellite: the hub writes placeholders and the desk agent puts its own
 * paths in (see DeskAgent.localise), after making sure the servers are installed there.
 */
export const DESK_PATHS: McpPaths = {
  node: '{{sb:node}}',
  cli: '{{sb:cli}}',
  preload: '{{sb:preload}}',
  playwright: '{{sb:playwright}}',
  ms365: '{{sb:ms365}}',
  googlePort: '{{sb:gport}}',
  logs: '{{sb:logs}}',
  url: '{{sb:url}}',
};

/**
 * Put a machine's own paths into a file the hub wrote with DESK_PATHS. A server this machine does not
 * have installed is taken out again (Playwright falls back to npx), so the session still starts.
 */
export function fillDeskPaths(text: string, p: McpPaths): string {
  if (!text.includes('{{sb:')) return text;
  const json = (v: string): string => JSON.stringify(v).slice(1, -1);
  const filled = text
    .replaceAll('{{sb:node}}', json(p.node))
    .replaceAll('{{sb:cli}}', json(p.cli))
    .replaceAll('{{sb:preload}}', json(p.preload))
    .replaceAll('{{sb:playwright}}', json(p.playwright ?? ''))
    .replaceAll('{{sb:ms365}}', json(p.ms365 ?? ''))
    .replaceAll('{{sb:gport}}', p.googlePort)
    .replaceAll('{{sb:logs}}', json(p.logs))
    .replaceAll('{{sb:url}}', json(p.url ?? 'http://127.0.0.1:4477'));
  try {
    const file = JSON.parse(filled) as { mcpServers?: Record<string, { args?: unknown[] }> };
    const servers = file.mcpServers;
    if (!servers) return filled;
    let changed = false;
    for (const [name, entry] of Object.entries(servers)) {
      if (!Array.isArray(entry.args) || !entry.args.includes('')) continue;
      if (name === 'playwright') servers[name] = playwrightEntry({ ...p, playwright: null }) as { args?: unknown[] };
      else delete servers[name];
      changed = true;
    }
    return changed ? JSON.stringify(file, null, 2) : filled;
  } catch {
    return filled;
  }
}

/** The Playwright server for one session: its own browser profile in memory, so sessions never collide. */
export function playwrightEntry(p: McpPaths): Record<string, unknown> {
  // Until the pinned install is there, npx runs the same version.
  if (!p.playwright) return { type: 'stdio', command: IS_WINDOWS ? 'npx.cmd' : 'npx', args: ['-y', `${PLAYWRIGHT_PACKAGE}@${PLAYWRIGHT_VERSION}`, '--isolated'] };
  return { type: 'stdio', command: p.node, args: [p.playwright, '--isolated'] };
}

/**
 * The Microsoft server for one account of one session, or null until it is installed. Its tokens come
 * from Switchboard through our preload; it never signs in or keeps a token cache of its own.
 */
export function ms365Entry(p: McpPaths, input: { account: string; ticket: string; clientId: string; work: boolean; run: string }): Record<string, unknown> | null {
  if (!p.ms365) return null;
  return {
    type: 'stdio',
    command: p.node,
    args: ['--import', p.preload, p.ms365, ...(input.work ? ['--org-mode'] : [])],
    env: {
      SWITCHBOARD_ACCOUNT: input.account,
      SWITCHBOARD_ACCOUNT_TICKET: input.ticket,
      ...(p.url ? { SWITCHBOARD_URL: p.url } : {}),
      // Token mode: no account switching and no token cache of its own.
      MS365_MCP_OAUTH_TOKEN: 'switchboard',
      MS365_MCP_CLIENT_ID: input.clientId,
      MS365_MCP_USE_KEYTAR: '0',
      MS365_MCP_TOKEN_CACHE_PATH: `${p.logs}/${input.run}/no-cache.json`,
      MS365_MCP_LOG_DIR: `${p.logs}/${input.run}`,
    },
  };
}

/** The Google server entry for one account of one session: the shared server, with that account's token. */
export function googleEntry(p: McpPaths, input: { account: string; ticket: string }): Record<string, unknown> {
  const q = (v: string): string => `"${v}"`;
  const helper = [q(p.node), q(p.cli), 'account-token', '--account', input.account, '--header', '--ticket', input.ticket, ...(p.url ? ['--url', p.url] : [])].join(' ');
  return { type: 'http', url: `http://127.0.0.1:${p.googlePort}/mcp`, headersHelper: helper };
}
