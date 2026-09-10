import fs from 'node:fs';

/** How much of the tail to read. Enough for several turns even with large tool results. */
const TAIL_BYTES = 128 * 1024;

interface Entry {
  type?: string;
  isSidechain?: boolean;
  message?: { model?: string };
}

/**
 * The model in force for a session, read from the newest assistant turn in its transcript.
 *
 * Claude Code reports the model in the SessionStart hook and nowhere else, so a mid-session
 * `/model` would otherwise go unnoticed until the session restarts. The transcript records it on
 * every assistant message, which makes it the only live source. Subagent turns run on their own
 * model and are skipped.
 */
export function readSessionModel(file: string): string | null {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buf = Buffer.allocUnsafe(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  // The first line is usually a fragment, since the read starts mid-file.
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    const model = entry.message?.model;
    if (typeof model === 'string' && model && model !== '<synthetic>') return model;
  }
  return null;
}
