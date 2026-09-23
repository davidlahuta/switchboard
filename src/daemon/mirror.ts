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

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    // Enough history that a viewer opening the plain renderer can scroll back through the session.
    this.term = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  get viewers(): number {
    return this.clients.size;
  }

  write(data: string): void {
    this.term.write(data);
    this.broadcast({ type: 'data', data });
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    this.broadcast({ type: 'resize', cols, rows });
  }

  reset(): void {
    this.term.reset();
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

  dispose(): void {
    this.clients.clear();
    this.term.dispose();
  }
}
