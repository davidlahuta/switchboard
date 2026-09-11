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
      // Found by socket rather than by the id this connection said hello with, because a session
      // that cleared its conversation has since been re-keyed to a new one; see rekey.
      for (const [id, conn] of this.conns) {
        if (conn.ws !== ws) continue;
        this.conns.delete(id);
        // The shim is a child of claude, so this is usually the session ending. Usually is not
        // always — a daemon restart closes every one of these — so the coordinator weighs it
        // rather than acting on it. See Coordinator.shimClosed.
        this.coord.shimClosed(id);
        return;
      }
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
      /*
       * The second witness of which conversation a run is actually on.
       *
       * Until now only a hook could say — and a hook only says it while carrying the run id, which
       * means the session has to do something first. A session nobody types into does nothing: it
       * comes up, connects, and waits. So a resume that quietly came up on the wrong conversation
       * went unnoticed until somebody typed at it, and the promise a spawn makes about which id it
       * is fetching stayed open for as long as the session stayed quiet.
       *
       * This connection carries both ids and arrives the moment claude starts, whoever is or is not
       * watching. If it says the run is somewhere it should not be, the run disowns it here exactly
       * as it would on a hook.
       */
      if (msg.runId && !this.runs.rebind(msg.runId, msg.sessionId)) {
        log.warn('a session announced itself on a conversation its run had disowned', { run: msg.runId, session: msg.sessionId });
        ws.close();
        return;
      }
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

  /**
   * Move a live shim to the session id it now belongs to.
   *
   * The shim takes its session id from the environment when the process starts and repeats it on
   * every reconnect, so a `/clear` — which starts a new conversation without restarting MCP
   * servers — leaves the only channel into that terminal filed under a conversation that has ended.
   * The socket is the same socket; only the name on it is out of date.
   */
  rekey(oldId: string, newId: string): boolean {
    const conn = this.conns.get(oldId);
    if (!conn || oldId === newId) return false;
    this.conns.delete(oldId);
    const previous = this.conns.get(newId);
    if (previous && previous.ws !== conn.ws) previous.ws.close();
    this.conns.set(newId, conn);
    log.debug('shim re-keyed', { from: oldId, to: newId });
    return true;
  }
}
