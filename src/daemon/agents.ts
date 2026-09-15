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
      queue = queue.then(() => this.onMessage(ws, msg, reply, (id) => (sessionId = id), () => this.sessionOf(ws) ?? sessionId)).catch((err) => {
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
      /*
       * Which conversation this connection belongs to is the run's to say, never the shim's.
       *
       * The shim takes its session id from CLAUDE_CODE_SESSION_ID, which Claude Code sets once, when
       * it starts its MCP servers — and a `/clear` starts a new conversation without restarting them.
       * So after a clear the shim announces the conversation its process *started* with, on every
       * reconnect, for as long as the process lives. It used to be asked to rebind the run on the
       * strength of that. The guard refused it, until the second its claude was killed for a swap and
       * no registry file was left to contradict it: run 29e12d39 moved back onto the conversation it
       * had cleared that morning, and the relaunch resumed that instead of the one that was working.
       *
       * What a shim can say honestly is which process started it. If that is the process the run
       * hosts, it is the run's channel, filed under whatever conversation the run's hooks say is live
       * and moved with it by rekey. If it is not, it is some other claude carrying the run id, and is
       * told so. A failed resume is still caught — by the hooks, which come from the conversation
       * itself.
       */
      const hosted = msg.runId ? this.runs.row(msg.runId) : undefined;
      const parent = msg.ppid ?? msg.pid;
      if (hosted && !this.runs.hostsProcess(hosted.id, parent)) {
        log.debug('a claude that is not this run announced itself under its id', { run: hosted.id, pid: parent, claimed: msg.sessionId });
        // Told, not just dropped: a shim that is only hung up on comes straight back.
        reply({ type: 'disowned', reason: `${hosted.id} is hosted by another process` });
        ws.close();
        return;
      }
      const sessionId = hosted ? hosted.session_id : msg.sessionId;
      setSession(sessionId);
      // A session announcing itself is a terminal that came up, which is the thing a revive was
      // waiting to see. SessionStart would say so too, when it fires; this does not depend on it.
      if (hosted) this.runs.cameBack(hosted.id);
      const run = hosted ?? (msg.runId ? undefined : this.runs.bySession(msg.sessionId));
      const agent = await this.coord.registerAgent({
        sessionId,
        cwd: msg.cwd,
        pid: parent,
        runId: run?.id ?? null,
        subscriptionId: run?.subscription_id ?? null,
        hasChannel: msg.channel,
        name: this.coord.agent(sessionId) ? null : (run?.name ?? null),
      });
      const previous = this.conns.get(sessionId);
      if (previous && previous.ws !== ws) previous.ws.close();
      this.conns.set(sessionId, { ws, channel: msg.channel });
      reply({ type: 'welcome', agentName: agent.name });
      if (msg.channel) this.coord.flushPushQueue(sessionId);
      log.debug('shim connected', { session: sessionId, claimed: msg.sessionId, channel: msg.channel });
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

  /**
   * The session a socket is filed under now.
   *
   * Not the id it said hello with: a `/clear` re-keys the connection to the new conversation (see
   * rekey), and tool calls read from here, so a claim or an intent made after a clear is the new
   * conversation's rather than the one that has ended.
   */
  private sessionOf(ws: WebSocket): string | null {
    for (const [id, conn] of this.conns) if (conn.ws === ws) return id;
    return null;
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
