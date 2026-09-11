import pty from '@lydell/node-pty';
import WebSocket from 'ws';
import { DAEMON_URL, DAEMON_WS, PTY_TERM, withoutParentSession } from '../config.ts';
import { scanForLimit } from '../shared/limits.ts';
import type { DaemonToRunner, ManualRunSpec, RunnerToDaemon, SpawnSpec } from '../shared/protocol.ts';

type IPty = ReturnType<typeof pty.spawn>;

// Undo whatever modes the TUI left enabled before printing our own output.
const RESET_TERMINAL = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[?25h\x1b[0m';
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
/**
 * How long after a spawn the console's own size changes are treated as it settling rather than as
 * somebody reaching for the window.
 *
 * A Windows Terminal tab does not open at its final size: it reports one, then another as the window
 * lays itself out, sometimes seconds later. Taking those for a person asking for the session back is
 * how a session opened from a phone ended up drawn for the desk it was opened on.
 */
const CONSOLE_SETTLE_MS = 20_000;
/** Shown in the console the session lives in while a web viewer owns the pseudo-terminal size. */
const PARKED = (cols: number, rows: number): string =>
  `\x1b[1;36m[switchboard]\x1b[0m this session is being driven from the web at ${cols}\u00d7${rows}.\r\n` +
  `Output is paused here: one terminal cannot draw two sizes at once.\r\n` +
  `Resize this window, or close the web view, to take it back.\r\n`;
/** Set the title of the window this runner lives in (Windows Terminal tab, or the console). */
const setTitle = (t: string): string => `\x1b]0;${t.replace(/[\x1b\x07]/g, '')}\x07`;
/**
 * Title sequences claude emits, dropped before they reach this console. The tab carries the
 * session's name, which the operator can change; letting the session overwrite it would put the
 * name back a moment after every rename.
 */
// eslint-disable-next-line no-control-regex
const OSC_TITLE_RE = /\x1b][012];[^\x1b\x07]*(?:\x07|\x1b\\)/g;
/**
 * The confirmation Claude Code shows at startup for `--dangerously-load-development-channels`.
 * Matched with the whitespace removed, because the interface writes it a cell at a time.
 */
const DEV_CHANNEL_WARNING = 'WARNING:Loadingdevelopmentchannels';
const DEV_CHANNEL_ACCEPT = 'Iamusingthisforlocaldevelopment';
/** The only channel this is ever answered for: Switchboard's own server, on this machine. */
const OWN_CHANNEL = 'server:switchboard';

/**
 * The folder trust confirmation, matched with the whitespace removed like the one above.
 *
 * Trust is normally granted in the profile before the process starts, so this should never be
 * reached. It is answered anyway for the one folder the session was launched into, because the
 * option it starts on is "No, exit" and a session stuck here is a session nobody is at.
 */
const TRUST_PROMPT = 'Accessingworkspace:';
const TRUST_ACCEPT = 'Yes,Itrustthisfolder';
const DOWN = '\x1b[B';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-_]/g;

/** No more than one limit reported this often, however many times the banner is redrawn. */
const LIMIT_REPORT_EVERY_MS = 60_000;
/**
 * How long after a spawn the terminal's output says nothing about usage. Long enough for a resumed
 * conversation to finish replaying itself, which is where the old banners live.
 */
const LIMIT_QUIET_AFTER_SPAWN_MS = 45_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** This process's start time. The daemon compares it with the source to spot a stale runner. */
const STARTED_AT = new Date().toISOString();

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
  /**
   * The PTY is currently sized by a web viewer rather than by this console.
   *
   * One pseudo-terminal cannot serve two windows of different sizes: claude positions the cursor
   * absolutely and wraps for the size it was given, so drawing that into a console of another size
   * lands lines on top of each other. Windows Terminal ignores a programmatic resize (CSI 8;h;w t),
   * so the console cannot be made to follow. It is parked instead: output stops being written here
   * until the size comes back, which is the only state in which this console can show the truth.
   */
  let webSized = false;
  /**
   * The size a browser last asked for, kept across respawns.
   *
   * A swap, a restart and a resume all end one pseudo-terminal and start another, and the browser
   * has no reason to say anything: nothing changed on its end, so its ResizeObserver stays quiet.
   * Without remembering, the new claude comes up at this console's dimensions while a phone is
   * looking at it, and the first thing the viewer sees is a frame drawn for the wrong screen.
   */
  let webSize: { cols: number; rows: number } | null = null;
  /** When the current claude was started, so the console's settling resizes can be told apart. */
  let spawnedAt = 0;
  /**
   * The size the pseudo-terminal actually has, kept here rather than read back from it. node-pty
   * applies a resize through a deferred callback, so asking it a moment later can still answer with
   * the dimensions it was spawned at — which is how a session that had already been fitted to a
   * browser reported itself as the shape of the console a second after starting.
   */
  let childSize = { cols: 0, rows: 0 };
  const resizeChild = (cols: number, rows: number): void => {
    if (!child) return;
    childSize = { cols, rows };
    child.resize(cols, rows);
  };
  let swapping = false;
  let stopping = false;
  let ws: WebSocket | null = null;
  let everConnected = false;
  let backoff = 500;
  let tail = '';
  let lastLimitReport = 0;
  let channelPromptAnswered = false;
  let trustPromptAnswered = false;
  let cwdKey = '';

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

  /** Take the size back for this console: unpark it and make claude repaint at these dimensions. */
  const unpark = (): void => {
    if (!child) return;
    const { cols, rows } = size();
    webSized = false;
    webSize = null;
    resizeChild(cols, rows);
    out.write(CLEAR);
    send({ type: 'resize', cols, rows });
    // Nudge a full repaint: claude only redraws its frame when the size actually changes, and it
    // has just been told about this one.
    setTimeout(() => {
      if (!child || webSized) return;
      resizeChild(Math.max(20, cols - 1), rows);
      setTimeout(() => {
        if (child && !webSized) resizeChild(cols, rows);
      }, 60);
    }, 60);
  };

  out.on('resize', () => {
    if (!child) return;
    // Resizing this window is also how you take the session back from a web viewer — but only once
    // the window has stopped resizing itself. A tab that has just opened reports its size more than
    // once while it lays out, and reading that as a request would hand the session straight back to
    // a console nobody is looking at.
    if (webSized) {
      if (Date.now() - spawnedAt < CONSOLE_SETTLE_MS) return;
      unpark();
      return;
    }
    const { cols, rows } = size();
    resizeChild(cols, rows);
    send({ type: 'resize', cols, rows });
  });

  /**
   * Answer the development-channels warning.
   *
   * Switchboard registers its own MCP server as a channel so it can push messages into an idle
   * session, and that flag makes Claude Code stop at a confirmation every time a session starts.
   * The warning is about running channels obtained from elsewhere, so it is only answered when the
   * list is exactly this machine's own Switchboard server and nothing else. The wanted option is
   * the one already highlighted, so confirming is all it takes.
   */
  const answerChannelPrompt = (): void => {
    if (channelPromptAnswered || !child) return;
    const squished = tail.replace(/\s+/g, '');
    if (!squished.includes(DEV_CHANNEL_WARNING) || !squished.includes(DEV_CHANNEL_ACCEPT)) return;
    const listed = squished.slice(squished.indexOf('Channels:') + 'Channels:'.length, squished.indexOf(DEV_CHANNEL_ACCEPT));
    if (!listed.includes(OWN_CHANNEL) || listed.replace(OWN_CHANNEL, '').replace(/[^a-z]/gi, '') !== '') return;
    channelPromptAnswered = true;
    tail = '';
    setTimeout(() => child?.write('\r'), 150);
  };

  /**
   * Answer the folder trust confirmation, for the folder this session was launched into and no
   * other. The wanted option is the second one; the first is "No, exit".
   */
  const answerTrustPrompt = (): void => {
    if (trustPromptAnswered || !child || !cwdKey) return;
    const squished = tail.replace(/\s+/g, '');
    if (!squished.includes(TRUST_PROMPT) || !squished.includes(TRUST_ACCEPT)) return;
    if (!squished.includes(cwdKey)) return;
    trustPromptAnswered = true;
    tail = '';
    setTimeout(() => {
      child?.write(DOWN);
      setTimeout(() => child?.write('\r'), 120);
    }, 150);
  };

  const detectLimit = (data: string): void => {
    tail = (tail + data.replace(ANSI_RE, '')).slice(-2000);
    if (Date.now() - lastLimitReport < LIMIT_REPORT_EVERY_MS) return;
    const found = scanForLimit(tail);
    if (found.kind === 'none') return;
    if (found.kind === 'ignored') {
      // The session printed the words rather than being shown them. Drop that line and keep
      // reading, because the next thing on screen may be the real thing.
      tail = tail.slice(found.restFrom);
      return;
    }
    lastLimitReport = Date.now();
    tail = '';
    send({ type: 'limit-detected', text: found.text, cause: found.cause });
  };

  const spawnChild = (s: SpawnSpec): void => {
    runId = s.runId;
    channelPromptAnswered = false;
    trustPromptAnswered = false;
    cwdKey = s.cwd.replace(/\s+/g, '');
    const env = { ...withoutParentSession(), ...PTY_TERM };
    for (const [k, v] of Object.entries(s.env)) {
      if (v === null) delete env[k];
      else env[k] = v;
    }
    // Whoever owns the size still owns it: a session that comes back under a browser comes back at
    // the browser's dimensions, not at this console's.
    const { cols, rows } = webSize ?? size();
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
    spawnedAt = Date.now();
    /*
     * Resuming replays the conversation, and a conversation that once hit a usage limit replays the
     * banner saying so. Read as live, that banner moved the session again the instant it arrived on
     * its new subscription — attributed to whichever one it had just landed on, which was rarely
     * the one that had actually run out. The tail goes with the old process, and nothing is
     * believed until the replay is over.
     */
    tail = '';
    lastLimitReport = Date.now() + LIMIT_QUIET_AFTER_SPAWN_MS - LIMIT_REPORT_EVERY_MS;
    childSize = { cols, rows };
    if (webSize && !webSized) {
      // Parked from the moment it starts, rather than painting one frame here first.
      out.write(CLEAR + PARKED(webSize.cols, webSize.rows));
      webSized = true;
    }
    p.onData((d) => {
      if (!webSized) out.write(d.includes(']') ? d.replace(OSC_TITLE_RE, '') : d);
      send({ type: 'data', data: d });
      detectLimit(d);
      answerChannelPrompt();
      answerTrustPrompt();
    });
    p.onExit(({ exitCode }) => {
      if (child === p) child = null;
      if (swapping) return;
      send({ type: 'exit', code: exitCode, intentional: stopping });
      out.write(RESET_TERMINAL);
      if (!stopping) say(`claude exited (${exitCode}). Resume it from Switchboard, or here with: claude --resume ${s.sessionId}`);
      /*
       * Windows Terminal keeps a tab whose process exited non-zero (closeOnExit: automatic), which
       * is what you want for a crash — the screen is the only account of it at the desk — and not
       * what you want for a stop or a relaunch, where the tab was asked to go and killing claude
       * returns non-zero anyway. So an exit that was asked for reports success, and only a session
       * that fell over on its own leaves its tab behind.
       */
      setTimeout(() => process.exit(stopping ? 0 : (exitCode ?? 0)), 400);
    });
    out.write(setTitle(s.title));
    send({ type: 'spawned', pid: p.pid, cols, rows });
    /*
     * ConPTY resolves the child pid asynchronously; report it once it is known.
     *
     * With the size it has by then, not the one it started with. A browser that asked for its size
     * while the session was starting has already resized this pty in the meantime, and repeating the
     * spawn dimensions a second later told the daemon the session was still the shape of the console
     * — which is the shape it then drew its mirror at, for a viewer looking at something else.
     */
    if (!p.pid) {
      setTimeout(() => {
        if (child === p && p.pid) send({ type: 'spawned', pid: p.pid, cols: childSize.cols, rows: childSize.rows });
      }, 1000);
    }
  };

  /*
   * Respawns run one at a time, however fast they arrive.
   *
   * This used to be a plain async function called from an unawaited message handler, so two swaps
   * milliseconds apart — which is what a usage limit produced when two parts of the daemon answered
   * it at once — ran concurrently. Both killed the same child, both waited, and both spawned: two
   * claude processes on one conversation. The second `--resume` then failed because the first still
   * held the transcript, and when the orphan exited it reported an unexpected exit that took the
   * whole terminal down with it. That is how a session died overnight rather than swapping.
   *
   * The daemon no longer sends them that way, and this makes it impossible to matter.
   */
  let respawnQueue: Promise<void> = Promise.resolve();

  const swapTo = (next: SpawnSpec, banner: string): Promise<void> => {
    respawnQueue = respawnQueue.then(async () => {
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
      // Let the new process take hold before another swap can kill it: a respawn that lands during
      // startup leaves claude half-initialised and the conversation locked by a process that is on
      // its way out.
      await sleep(1500);
    });
    return respawnQueue;
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
      case 'resize': {
        const mine = size();
        const takenOver = msg.cols !== mine.cols || msg.rows !== mine.rows;
        // Recorded before anything else, so a size that arrives while claude is still starting is
        // waiting for it rather than thrown away. That gap is exactly when a new session is opened
        // from the browser, which is when this went wrong.
        webSize = takenOver ? { cols: msg.cols, rows: msg.rows } : null;
        if (!child) break;
        if (takenOver && !webSized) {
          // Park: stop drawing here rather than drawing a frame meant for another size.
          out.write(CLEAR + PARKED(msg.cols, msg.rows));
          webSized = true;
        } else if (!takenOver && webSized) {
          unpark();
          break;
        }
        resizeChild(msg.cols, msg.rows);
        send({ type: 'resize', cols: msg.cols, rows: msg.rows });
        break;
      }
      case 'type':
        // Type the text, then submit it separately so the TUI doesn't treat it as a paste.
        child?.write(msg.text);
        await sleep(200);
        child?.write('\r');
        break;
      case 'restore-size':
        // Nobody is driving from a browser any more, so this console owns the size again.
        if (child && webSized) unpark();
        break;
      case 'title':
        out.write(setTitle(msg.text));
        break;
      case 'redraw': {
        // Nudge the TUI into a full repaint so the daemon's mirror catches up.
        const { cols, rows } = size();
        resizeChild(Math.max(20, cols - 1), rows);
        await sleep(80);
        resizeChild(cols, rows);
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
      send({ type: 'hello', runId, manual: runId ? undefined : opts.manual, alive: !!child, pid: child?.pid ?? null, cols, rows, startedAt: STARTED_AT });
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
