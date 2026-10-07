import { withoutParentSession } from '../config.ts';
import { logger } from '../log.ts';
import type { ClaudeLogin } from '../shared/types.ts';
import { spawnOff, type OffChild } from '../spawnOff.ts';
import type { Bus } from './bus.ts';
import { claudeCommand, findClaude } from './claude.ts';

const log = logger('login');

/** How long a sign-in may wait for somebody to finish it. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** How long a finished sign-in stays on the card, so whoever watched it sees how it ended. */
const DONE_SHOWN_MS = 60_000;

/** Terminal escapes out of claude's output: colours, and the OSC 8 links it wraps the URL in. */
export function plainText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

/** The sign-in link `claude auth login` prints for when the browser does not open. */
export function loginUrlIn(text: string): string | null {
  const m = plainText(text).match(/https:\/\/\S+\/oauth\/authorize\?\S+/);
  return m ? m[0] : null;
}

/** A code as the callback page shows it, or null: one line, nothing that could be a second answer. */
export function cleanLoginCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim();
  return c && c.length <= 4096 && !/\s/.test(c) ? c : null;
}

interface Flow {
  state: ClaudeLogin;
  child: OffChild | null;
  output: string;
  timer: NodeJS.Timeout | null;
}

/**
 * `claude auth login`, run by the daemon rather than in a terminal on the desk, so it can be finished
 * from anywhere the web app is. claude still opens the browser on the desk, and signing in there
 * completes it as before. Its link for when that does not happen goes to the web app, and so does
 * the code that link's page hands back, which is written to claude's stdin.
 */
export class ClaudeLogins {
  private readonly flows = new Map<string, Flow>();

  private readonly bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  /** The sign-in under way (or just ended) for a subscription. */
  get(id: string): ClaudeLogin | null {
    return this.flows.get(id)?.state ?? null;
  }

  /** Start signing a profile in, replacing any sign-in already under way for it. */
  start(id: string, input: { configDir: string | null; email: string | null; label: string }): void {
    this.cancel(id, false);
    const flow: Flow = { state: { status: 'starting', url: null, error: null, startedAt: new Date().toISOString() }, child: null, output: '', timer: null };
    this.flows.set(id, flow);
    const claude = findClaude();
    if (!claude) return this.end(id, flow, 'failed', 'claude is not on PATH on the hub.');
    // Never a session's own environment: a claude inheriting SWITCHBOARD_RUN_ID belongs to that run.
    const env = withoutParentSession();
    if (input.configDir) env.CLAUDE_CONFIG_DIR = input.configDir;
    else delete env.CLAUDE_CONFIG_DIR;
    const cmd = claudeCommand(claude, ['auth', 'login', '--claudeai', ...(input.email ? ['--email', input.email] : [])]);
    const child = spawnOff(cmd.file, cmd.args, { env, stream: true, stdin: true, windowsHide: true });
    flow.child = child;
    const take = (d: string): void => {
      if (this.flows.get(id) !== flow) return;
      flow.output = (flow.output + d).slice(-64 * 1024);
      if (!flow.state.url) {
        const url = loginUrlIn(flow.output);
        if (url) {
          flow.state = { ...flow.state, status: 'waiting', url };
          this.bus.invalidate('state');
        }
      }
    };
    child.on('stdout', take);
    child.on('stderr', take);
    child.on('error', (err: Error) => this.end(id, flow, 'failed', err.message));
    child.on('exit', (code: number | null) => {
      if (code === 0) return this.end(id, flow, 'done', null);
      const last = plainText(flow.output)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop()
        // the prompt has no line break after it, so claude's answer lands on the same line
        ?.replace(/^.*if prompted >\s*/, '');
      this.end(id, flow, 'failed', last ?? `claude auth login exited with code ${code}`);
    });
    flow.timer = setTimeout(() => {
      child.kill();
      this.end(id, flow, 'failed', 'Nobody finished signing in within 15 minutes.');
    }, LOGIN_TIMEOUT_MS);
    flow.timer.unref?.();
    log.info('signing a subscription in', { subscription: id, label: input.label });
    this.bus.invalidate('state');
  }

  /** The code from the page the sign-in link ends on, handed to claude as if typed. */
  submit(id: string, code: unknown): void {
    const flow = this.flows.get(id);
    const c = cleanLoginCode(code);
    if (!c) throw Object.assign(new Error('That is not a code: paste it exactly as the page shows it.'), { status: 400 });
    if (!flow?.child || (flow.state.status !== 'waiting' && flow.state.status !== 'submitted')) {
      throw Object.assign(new Error('No sign-in is waiting for a code. Start it again.'), { status: 409 });
    }
    flow.child.write(`${c}\n`);
    flow.state = { ...flow.state, status: 'submitted', error: null };
    this.bus.invalidate('state');
  }

  cancel(id: string, announce = true): void {
    const flow = this.flows.get(id);
    if (!flow) return;
    if (flow.state.status === 'starting' || flow.state.status === 'waiting' || flow.state.status === 'submitted') flow.child?.kill();
    if (flow.timer) clearTimeout(flow.timer);
    this.flows.delete(id);
    if (announce) this.bus.invalidate('state');
  }

  stopAll(): void {
    for (const id of [...this.flows.keys()]) this.cancel(id, false);
  }

  private end(id: string, flow: Flow, status: 'done' | 'failed', error: string | null): void {
    if (this.flows.get(id) !== flow || flow.state.status === 'done' || flow.state.status === 'failed') return;
    if (flow.timer) clearTimeout(flow.timer);
    flow.child = null;
    flow.state = { ...flow.state, status, error };
    if (status === 'failed') log.warn('a subscription sign-in failed', { subscription: id, error });
    if (status === 'done') {
      flow.timer = setTimeout(() => {
        if (this.flows.get(id) === flow) this.flows.delete(id);
        this.bus.invalidate('state');
      }, DONE_SHOWN_MS);
      flow.timer.unref?.();
    }
    this.bus.invalidate('state');
  }
}
