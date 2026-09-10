import serializePkg from '@xterm/addon-serialize';
import headlessPkg from '@xterm/headless';
import type { TermServerFrame } from '../shared/types.ts';

const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;

type Send = (frame: TermServerFrame) => void;

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
    this.term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
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
      send({ type: 'snapshot', data: this.serializer.serialize({ scrollback: 500 }), cols: this.cols, rows: this.rows });
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
