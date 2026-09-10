import pty from '@lydell/node-pty';
import WebSocket from 'ws';
import { DAEMON_URL, DAEMON_WS } from '../config.ts';
import type { DaemonToRunner, ManualRunSpec, RunnerToDaemon, SpawnSpec } from '../shared/protocol.ts';

type IPty = ReturnType<typeof pty.spawn>;

// Undo whatever modes the TUI left enabled before printing our own output.
const RESET_TERMINAL = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[?25h\x1b[0m';
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
const LIMIT_RE =
  /(usage limit reached|you['’]ve (hit|reached) your (usage |session |weekly |5-hour )?limit|(5-hour|weekly|session) limit reached|limit reached[^\n]{0,40}resets)/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Hosts one Claude Code session in a pseudo-terminal inside the current console window, relays
 * all I/O, mirrors the screen to the daemon and restarts claude under another subscription when
 * the daemon asks for a swap.
 */
export async function runRunner(opts: { runId?: string; manual?: ManualRunSpec }): Promise<void> {
  const out = process.stdout;
  const inp = process.stdin;
  let runId = opts.runId ?? null;
  let child: IPty | null = null;
  /** The PTY is currently sized by a web viewer rather than by this console. */
  let webSized = false;
  let swapping = false;
  let stopping = false;
  let ws: WebSocket | null = null;
  let everConnected = false;
  let backoff = 500;
  let tail = '';
  let lastLimitReport = 0;

  const size = (): { cols: number; rows: number } => ({ cols: out.columns || 120, rows: out.rows || 30 });
  const send = (msg: RunnerToDaemon): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const say = (text: string): void => {
    out.write(`\r\n\x1b[1;36m[switchboard]\x1b[0m ${text}\r\n`);
  };

  if (inp.isTTY) inp.setRawMode(true);
  inp.resume();
  inp.on('data', (buf: Buffer) => child?.write(buf.toString('utf8')));
  process.on('exit', () => {
    if (inp.isTTY) inp.setRawMode(false);
  });

  out.on('resize', () => {
    const { cols, rows } = size();
    if (!child) return;
    child.resize(cols, rows);
    // Coming back from a web-driven size, the console is full of a frame drawn for those other
    // dimensions; clear it so the repaint starts from a clean screen.
    if (webSized) {
      out.write(CLEAR);
      webSized = false;
    }
    send({ type: 'resize', cols, rows });
  });

  const detectLimit = (data: string): void => {
    tail = (tail + data.replace(ANSI_RE, '')).slice(-2000);
    if (Date.now() - lastLimitReport < 60_000) return;
    const m = tail.match(LIMIT_RE);
    if (!m) return;
    lastLimitReport = Date.now();
    tail = '';
    send({ type: 'limit-detected', text: m[0] });
  };

  const spawnChild = (s: SpawnSpec): void => {
    runId = s.runId;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    for (const [k, v] of Object.entries(s.env)) {
      if (v === null) delete env[k];
      else env[k] = v;
    }
    const { cols, rows } = size();
    let p: IPty;
    try {
      p = pty.spawn(s.file, s.args, { name: 'xterm-256color', cols, rows, cwd: s.cwd, env });
    } catch (err) {
      say(`failed to start claude: ${err instanceof Error ? err.message : err}`);
      send({ type: 'exit', code: 1, intentional: false });
      setTimeout(() => process.exit(1), 5000);
      return;
    }
    child = p;
    p.onData((d) => {
      out.write(d);
      send({ type: 'data', data: d });
      detectLimit(d);
    });
    p.onExit(({ exitCode }) => {
      if (child === p) child = null;
      if (swapping) return;
      send({ type: 'exit', code: exitCode, intentional: stopping });
      out.write(RESET_TERMINAL);
      if (!stopping) say(`claude exited (${exitCode}). Resume later with: claude --resume ${s.sessionId}`);
      setTimeout(() => process.exit(exitCode ?? 0), 400);
    });
    send({ type: 'spawned', pid: p.pid, cols, rows });
    // ConPTY resolves the child pid asynchronously; report it once it is known.
    if (!p.pid) {
      setTimeout(() => {
        if (child === p && p.pid) send({ type: 'spawned', pid: p.pid, cols, rows });
      }, 1000);
    }
  };

  const swapTo = async (next: SpawnSpec, banner: string): Promise<void> => {
    swapping = true;
    const old = child;
    if (old) {
      const exited = new Promise<void>((resolve) => old.onExit(() => resolve()));
      try {
        old.kill();
      } catch {
        // already gone
      }
      await Promise.race([exited, sleep(5000)]);
    }
    out.write(RESET_TERMINAL + CLEAR + banner);
    swapping = false;
    spawnChild(next);
  };

  const handle = async (msg: DaemonToRunner): Promise<void> => {
    switch (msg.type) {
      case 'spawn':
        if (!child) spawnChild(msg.spec);
        break;
      case 'swap':
        await swapTo(msg.spec, msg.banner);
        break;
      case 'input':
        child?.write(msg.data);
        break;
      case 'resize':
        if (!child) break;
        // The web view is taking the size over. The local console keeps showing the frame drawn
        // for the old size, and the TUI now repaints a smaller area inside it, which leaves the
        // old characters around and under the new frame. Wipe the console before it repaints.
        child.resize(msg.cols, msg.rows);
        out.write(CLEAR);
        webSized = msg.cols !== size().cols || msg.rows !== size().rows;
        send({ type: 'resize', cols: msg.cols, rows: msg.rows });
        break;
      case 'type':
        // Type the text, then submit it separately so the TUI doesn't treat it as a paste.
        child?.write(msg.text);
        await sleep(200);
        child?.write('\r');
        break;
      case 'restore-size': {
        if (!child || !webSized) break;
        // Nobody is watching from a browser any more, so this console owns the size again.
        const { cols, rows } = size();
        child.resize(cols, rows);
        out.write(CLEAR);
        webSized = false;
        send({ type: 'resize', cols, rows });
        break;
      }
      case 'redraw': {
        // Nudge the TUI into a full repaint so the daemon's mirror catches up.
        const { cols, rows } = size();
        child?.resize(Math.max(20, cols - 1), rows);
        await sleep(80);
        child?.resize(cols, rows);
        break;
      }
      case 'stop':
        stopping = true;
        if (child) child.kill();
        else process.exit(0);
        break;
      case 'error':
        say(`daemon error: ${msg.message}`);
        if (!child) setTimeout(() => process.exit(1), 8000);
        break;
    }
  };

  const connect = (): void => {
    const socket = new WebSocket(`${DAEMON_WS}/ws/runner`);
    socket.on('open', () => {
      ws = socket;
      everConnected = true;
      backoff = 500;
      const { cols, rows } = size();
      send({ type: 'hello', runId, manual: runId ? undefined : opts.manual, alive: !!child, pid: child?.pid ?? null, cols, rows });
    });
    socket.on('message', (raw) => {
      try {
        void handle(JSON.parse(String(raw)) as DaemonToRunner);
      } catch {
        // ignore malformed frames
      }
    });
    socket.on('close', () => {
      if (ws === socket) ws = null;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    });
    socket.on('error', () => {
      // 'close' follows
    });
  };

  connect();
  setTimeout(() => {
    if (!everConnected && !child) {
      say(`cannot reach the Switchboard daemon at ${DAEMON_URL}. Start it with \`aspire run\` (or \`npm run daemon\`).`);
      setTimeout(() => process.exit(1), 10_000);
    }
  }, 5000);
}
