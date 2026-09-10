import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { DAEMON_URL, DAEMON_WS, VERSION } from '../config.ts';
import { logger } from '../log.ts';
import type { DaemonToShim, ShimToDaemon } from '../shared/protocol.ts';
import { SERVER_INSTRUCTIONS, TOOLS } from '../shared/tools.ts';

const log = logger('mcp');

interface Result {
  text: string;
  isError: boolean;
}

/** Reconnecting link to the daemon. Tool calls wait briefly for a connection, then fail soft. */
class DaemonLink {
  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly pending = new Map<number, (r: Result) => void>();
  private backoff = 500;
  private readonly hello: ShimToDaemon;
  private readonly onPush: (content: string, meta: Record<string, string>) => void;
  private readyWaiters: Array<() => void> = [];

  constructor(hello: ShimToDaemon, onPush: (content: string, meta: Record<string, string>) => void) {
    this.hello = hello;
    this.onPush = onPush;
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(`${DAEMON_WS}/ws/agent`);
    ws.on('open', () => {
      this.ws = ws;
      this.backoff = 500;
      ws.send(JSON.stringify(this.hello));
      for (const w of this.readyWaiters) w();
      this.readyWaiters = [];
    });
    ws.on('message', (raw) => {
      let msg: DaemonToShim;
      try {
        msg = JSON.parse(String(raw)) as DaemonToShim;
      } catch {
        return;
      }
      if (msg.type === 'result') {
        this.pending.get(msg.id)?.({ text: msg.text, isError: msg.isError });
        this.pending.delete(msg.id);
      } else if (msg.type === 'push') {
        this.onPush(msg.content, msg.meta);
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      for (const [id, resolve] of this.pending) {
        resolve({ text: 'Switchboard daemon connection lost; retry shortly.', isError: true });
        this.pending.delete(id);
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    });
    ws.on('error', () => {
      // 'close' follows and schedules the reconnect
    });
  }

  private waitReady(ms: number): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Result> {
    if (!(await this.waitReady(3000))) {
      return { text: `Switchboard daemon is not reachable at ${DAEMON_URL}. Coordination is unavailable; continue your work normally.`, isError: true };
    }
    const id = ++this.seq;
    const wait = typeof args.await_reply_seconds === 'number' ? args.await_reply_seconds : 0;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          resolve({ text: 'Switchboard did not answer in time.', isError: true });
        },
        (wait + 30) * 1000,
      );
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.ws!.send(JSON.stringify({ type: 'call', id, tool, args } satisfies ShimToDaemon));
    });
  }
}

export async function runShim(): Promise<void> {
  const runId = process.env.SWITCHBOARD_RUN_ID || null;
  const hello: ShimToDaemon = {
    type: 'hello',
    sessionId: process.env.CLAUDE_CODE_SESSION_ID || `mcp-${crypto.randomUUID()}`,
    pid: Number(process.env.CLAUDE_PID) || process.ppid || null,
    cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    runId,
    // Sessions launched by Switchboard always load the channel; others can opt in explicitly.
    channel: !!runId || process.env.SWITCHBOARD_CHANNELS === '1',
  };

  const server = new Server(
    { name: 'switchboard', version: VERSION },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: SERVER_INSTRUCTIONS },
  );

  const link = new DaemonLink(hello, (content, meta) => {
    server
      .notification({ method: 'notifications/claude/channel', params: { content, meta } } as unknown as Parameters<typeof server.notification>[0])
      .catch((err: unknown) => log.warn('channel notification failed', err instanceof Error ? err.message : err));
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await link.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text: r.text }], isError: r.isError };
  });

  await server.connect(new StdioServerTransport());
  process.stdin.on('close', () => process.exit(0));
}
