import fs from 'node:fs';

/** How much of the tail to read. Enough for several turns even with large tool results. */
const TAIL_BYTES = 128 * 1024;

interface Entry {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { model?: string };
  attachment?: { type?: string; identity?: { modelId?: string } };
}

/**
 * The model in force for a session, from its transcript.
 *
 * Claude Code reports the model in the SessionStart hook and nowhere else, so the transcript is
 * the live source. Two kinds of record carry it: every assistant turn names the model it ran on,
 * and `/model` appends an attachment naming the new one the moment it is chosen — which is what
 * lets a change made in an idle session show up before its next turn. Whichever is newest wins.
 * Subagent turns run on their own model and are skipped.
 *
 * Only records written at or after `since` count. A session launched on a new model says nothing
 * about it until its first turn, and until then the newest record is the last turn of the old one:
 * read without this, an idle session relaunched on Opus 5.5 was put back on Opus 5 within seconds,
 * and came back on it at its next restart.
 */
export function readSessionModel(file: string, since = 0): string | null {
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
    if (entry.isSidechain) continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (at < since) return null; // everything further back is older still
    const model =
      entry.type === 'assistant' ? entry.message?.model : entry.attachment?.type === 'model' ? entry.attachment.identity?.modelId : undefined;
    if (typeof model === 'string' && model && model !== '<synthetic>') return model;
  }
  return null;
}

/**
 * The name shown for a session inside Claude Code, if it has been renamed there.
 *
 * `/rename` writes this file immediately, which is the only live signal of it: the title also
 * arrives on the SessionStart and UserPromptSubmit hooks, but those do not fire when someone
 * renames a session and then looks at the web UI without typing anything.
 */
export function readCustomTitle(file: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const title = (JSON.parse(text) as { customTitle?: unknown }).customTitle;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

/** What a conversation is called: its custom title or summary, else its first prompt. */
export function transcriptTitle(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let firstPrompt: string | null = null;
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let j: Record<string, any>;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if ((j.type === 'custom-title' || j.type === 'summary') && typeof (j.customTitle ?? j.summary) === 'string') return j.customTitle ?? j.summary;
      if (!firstPrompt && j.type === 'user') {
        const c = j.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p: any) => p?.type === 'text')?.text : null;
        if (typeof text === 'string' && !text.startsWith('<')) firstPrompt = text.replace(/\s+/g, ' ').slice(0, 100);
      }
    }
    return firstPrompt ?? '(no prompt)';
  } catch {
    return '(unreadable)';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
