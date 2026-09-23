import fs from 'node:fs';
import path from 'node:path';
import serializePkg from '@xterm/addon-serialize';
import headlessPkg from '@xterm/headless';
import type { TermServerFrame } from '../shared/types.ts';

const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;

type Send = (frame: TermServerFrame) => void;

/**
 * Lines of history a viewer is sent when it opens a session. It was 500, and a session on the plain
 * renderer could be scrolled back only that far in the browser: one long turn is more than that.
 */
export const SNAPSHOT_HISTORY = 5000;

/** A screen log is cut back to its last LOG_KEEP bytes once it grows past LOG_MAX. */
const LOG_MAX = 8 * 1024 * 1024;
const LOG_KEEP = 4 * 1024 * 1024;

/** The DEC private mode that selects each mouse encoding xterm knows; DEFAULT needs none. */
const ENCODING_MODE: Record<string, string> = { SGR: '[?1006h', SGR_PIXELS: '[?1016h', URXVT: '[?1015h', UTF8: '[?1005h' };

/**
 * The mouse encoding a program chose, as the sequence that chooses it again.
 *
 * The serializer restores which mouse events a program asked for but not the format it wants them
 * in, and Claude Code asks for SGR once, at startup. A viewer that joined later was told "send me
 * the wheel" and not how, so every wheel event reached the session in a format it does not read.
 */
export function mouseEncodingSequence(encoding: string | undefined): string {
  return (encoding && ENCODING_MODE[encoding]) ?? '';
}

interface Client {
  send: Send;
  /** Frames that arrived while the snapshot was being prepared. */
  queue: TermServerFrame[] | null;
}

/**
 * Server-side copy of a run's screen. New web viewers get an exact snapshot (including the
 * alternate screen used by Claude Code's fullscreen TUI) followed by the live stream.
 */
export class TermMirror {
  cols: number;
  rows: number;
  private term: InstanceType<typeof Terminal>;
  private serializer: InstanceType<typeof SerializeAddon>;
  private clients = new Set<Client>();

  /**
   * Where everything the session printed is kept, so the copy survives the daemon.
   *
   * The copy lived only in the daemon's memory, and a daemon restart started it empty: the web view
   * of a session could then be scrolled back only as far as the restart, which on a day of deploys
   * was a few dozen lines. The terminal host keeps running across a restart, but it keeps no
   * history; this file does, and a new copy is rebuilt from it before anything live is added.
   */
  private readonly logFile: string | null;
  private log: number | null = null;
  private logBytes = 0;

  constructor(cols: number, rows: number, logFile: string | null = null) {
    this.cols = cols;
    this.rows = rows;
    this.logFile = logFile;
    // Enough history that a viewer opening the plain renderer can scroll back through the session.
    this.term = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.restore();
  }

  private restore(): void {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      if (fs.existsSync(this.logFile)) {
        const text = fs.readFileSync(this.logFile, 'utf8');
        this.logBytes = Buffer.byteLength(text);
        if (text) this.term.write(text);
      }
      this.log = fs.openSync(this.logFile, 'a');
    } catch {
      this.log = null; // no history then, as before; the live screen still works
    }
  }

  private append(data: string): void {
    if (this.log === null || !this.logFile) return;
    try {
      fs.writeSync(this.log, data);
      this.logBytes += Buffer.byteLength(data);
      if (this.logBytes > LOG_MAX) this.compact();
    } catch {
      // a full disk costs history, never the session
    }
  }

  /** Keep the last LOG_KEEP bytes, from a line start so no escape sequence is cut in half. */
  private compact(): void {
    if (this.log === null || !this.logFile) return;
    fs.closeSync(this.log);
    const buf = fs.readFileSync(this.logFile);
    let from = Math.max(0, buf.length - LOG_KEEP);
    const nl = buf.indexOf(0x0a, from);
    if (nl >= 0) from = nl + 1;
    fs.writeFileSync(this.logFile, buf.subarray(from));
    this.logBytes = buf.length - from;
    this.log = fs.openSync(this.logFile, 'a');
  }

  get viewers(): number {
    return this.clients.size;
  }

  write(data: string): void {
    this.term.write(data);
    this.append(data);
    this.broadcast({ type: 'data', data });
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    this.broadcast({ type: 'resize', cols, rows });
  }

  /** A new process is drawing: what the last one printed is not its history. */
  reset(): void {
    // In order with what was written before it: xterm parses writes later, and a reset done at
    // once let output still queued from the old process land on the new one's screen.
    this.term.write('', () => this.term.reset());
    if (this.log === null || !this.logFile) return;
    try {
      // Emptied by path: on Windows a file opened for appending cannot be truncated through that handle.
      fs.closeSync(this.log);
      fs.writeFileSync(this.logFile, '');
      this.logBytes = 0;
      this.log = fs.openSync(this.logFile, 'a');
    } catch {
      this.log = null; // no history from here, as before; the live screen still works
    }
  }

  /** The visible screen as plain text. Used to check what a session is showing before typing at it. */
  screenText(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.rows; i++) {
      lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }

  broadcast(frame: TermServerFrame): void {
    for (const c of this.clients) {
      if (c.queue) c.queue.push(frame);
      else c.send(frame);
    }
  }

  attach(send: Send): () => void {
    const client: Client = { send, queue: [] };
    this.clients.add(client);
    // The empty write's callback runs after every earlier write has been parsed.
    this.term.write('', () => {
      if (!this.clients.has(client)) return;
      // xterm keeps the encoding on an internal service the public API does not expose.
      const encoding = (this.term as unknown as { _core?: { coreMouseService?: { activeEncoding?: string } } })._core?.coreMouseService?.activeEncoding;
      const data = this.serializer.serialize({ scrollback: SNAPSHOT_HISTORY }) + mouseEncodingSequence(encoding);
      send({ type: 'snapshot', data, cols: this.cols, rows: this.rows });
      const queued = client.queue ?? [];
      client.queue = null;
      for (const f of queued) if (f.type !== 'resize') send(f);
    });
    return () => {
      this.clients.delete(client);
    };
  }

  dispose(forget = false): void {
    this.clients.clear();
    this.term.dispose();
    if (this.log !== null) fs.closeSync(this.log);
    this.log = null;
    if (forget && this.logFile) fs.rmSync(this.logFile, { force: true });
  }
}
