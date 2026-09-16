import fs from 'node:fs';

/** How far back the first look at a transcript reads. Later looks read only what was added. */
const FIRST_READ_BYTES = 4 * 1024 * 1024;

const NOTIFICATION = /<task-notification>\s*<task-id>([\w-]+)<\/task-id>[\s\S]{0,4000}?<status>(\w+)<\/status>/g;
const OVER = new Set(['completed', 'failed', 'killed', 'stopped', 'exited']);

/**
 * Background tasks a stretch of transcript says are over.
 *
 * A background shell or monitor that ends on its own says so only to the model, as a
 * <task-notification> in the transcript. No hook fires for it, so the work stayed open until the
 * sweep gave up on it three quarters of an hour later — holding every queued respawn behind it. A
 * session that polled CI with a new watch each minute held thirteen "shells" open, and its new
 * terminal waited behind all of them.
 */
export function finishedTasks(text: string): string[] {
  const ids: string[] = [];
  // The transcript is JSON lines, so the tags sit inside strings with their newlines escaped.
  for (const m of text.replace(/\\n/g, '\n').matchAll(NOTIFICATION)) {
    if (OVER.has(m[2]!.toLowerCase())) ids.push(m[1]!);
  }
  return ids;
}

/** Reads each transcript forward from where it last stopped. */
export class TaskNotes {
  private readonly offsets = new Map<string, number>();

  finished(file: string): string[] {
    let fd: number | null = null;
    try {
      const size = fs.statSync(file).size;
      let from = this.offsets.get(file) ?? Math.max(0, size - FIRST_READ_BYTES);
      if (from > size) from = 0; // rewritten
      if (from === size) return [];
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      // Stop at the last complete line, so a record half-written now is read whole next time.
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) return [];
      this.offsets.set(file, from + end + 1);
      return finishedTasks(buf.subarray(0, end).toString('utf8'));
    } catch {
      return [];
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
}
