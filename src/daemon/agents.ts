import type { WebSocket } from 'ws';
import { logger } from '../log.ts';
import type { DaemonToShim, ShimToDaemon } from '../shared/protocol.ts';
import type { Coordinator, PushTarget } from './coord.ts';
import type { RunManager } from './runs.ts';

const log = logger('agents');

interface Conn {
  ws: WebSocket;
  channel: boolean;
}

/** Connections from the per-session MCP shims. Doubles as the coordinator's push channel. */
export class AgentHub implements PushTarget {
  private readonly coord: Coordinator;
  private readonly runs: RunManager;
  private readonly conns = new Map<string, Conn>();

  constructor(coord: Coordinator, runs: RunManager) {
    this.coord = coord;
    this.runs = runs;
  }

  attach(ws: WebSocket): void {
    let sessionId: string | null = null;
    const reply = (msg: DaemonToShim): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    // Registering an agent asks git which repository its cwd belongs to, so the messages after the
    // hello wait their turn rather than racing an agent that does not exist yet.
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      let msg: ShimToDaemon;
      try {
        msg = JSON.parse(String(raw)) as ShimToDaemon;
      } catch {
        return;
      }
      queue = queue.then(() => this.onMessage(ws, msg, reply, (id) => (sessionId = id), () => sessionId)).catch((err) => {
        log.warn('shim message failed', err instanceof Error ? err.message : err);
      });
    });
    ws.on('close', () => {
      if (sessionId && this.conns.get(sessionId)?.ws === ws) this.conns.delete(sessionId);
    });
  }

  private async onMessage(
    ws: WebSocket,
    msg: ShimToDaemon,
    reply: (m: DaemonToShim) => void,
    setSession: (id: string) => void,
    getSession: () => string | null,
  ): Promise<void> {
    if (msg.type === 'hello') {
      setSession(msg.sessionId);
      const run = msg.runId ? this.runs.row(msg.runId) : this.runs.bySession(msg.sessionId);
      const agent = await this.coord.registerAgent({
        sessionId: msg.sessionId,
        cwd: msg.cwd,
        pid: msg.pid,
        runId: run?.id ?? null,
        subscriptionId: run?.subscription_id ?? null,
        hasChannel: msg.channel,
        name: this.coord.agent(msg.sessionId) ? null : (run?.name ?? null),
      });
      const previous = this.conns.get(msg.sessionId);
      if (previous && previous.ws !== ws) previous.ws.close();
      this.conns.set(msg.sessionId, { ws, channel: msg.channel });
      reply({ type: 'welcome', agentName: agent.name });
      if (msg.channel) this.coord.flushPushQueue(msg.sessionId);
      log.debug('shim connected', { session: msg.sessionId, channel: msg.channel });
      return;
    }
    if (msg.type === 'call') {
      const sid = getSession();
      if (!sid) {
        reply({ type: 'result', id: msg.id, text: 'Switchboard: not registered yet', isError: true });
        return;
      }
      const r = await this.coord.runTool(sid, msg.tool, msg.args ?? {});
      reply({ type: 'result', id: msg.id, text: r.text, isError: r.isError });
    }
  }

  push(agentId: string, content: string, meta: Record<string, string>): boolean {
    const c = this.conns.get(agentId);
    if (!c || !c.channel || c.ws.readyState !== c.ws.OPEN) return false;
    c.ws.send(JSON.stringify({ type: 'push', content, meta } satisfies DaemonToShim));
    return true;
  }

  isConnected(agentId: string): boolean {
    const c = this.conns.get(agentId);
    return !!c && c.ws.readyState === c.ws.OPEN;
  }
}
