import fs from 'node:fs';
import path from 'node:path';
import type { SessionWorkKind } from '../shared/types.ts';

/** How far back the first look at a transcript reads. Later looks read only what was added. */
const FIRST_READ_BYTES = 2 * 1024 * 1024;
/** Tool calls remembered while their results are awaited; a turn rarely has more than a few open. */
const PENDING_TOOLS = 500;

const OVER = new Set(['completed', 'failed', 'killed', 'stopped', 'exited']);
const STOP_TOOLS = new Set(['TaskStop', 'KillShell']);
const OUTPUT_TOOLS = new Set(['TaskOutput', 'BashOutput']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const INTERRUPTED = '[Request interrupted by user';

/**
 * Something a transcript says happened, in the order it said it.
 *
 * Hooks are the fast path and the transcript is the record. A hook can be lost — the daemon was
 * restarting, it timed out, the event has no hook at all — and every one of those left a session
 * showing something that was no longer true: "working" after an Esc (no Stop fires), idle through
 * a turn a task notification started (no UserPromptSubmit fires), a monitor that was never listed
 * (its result says `taskId`, not `backgroundTaskId`), a shell dropped at forty-five minutes while
 * its recipe still ran. Claude Code writes all of it down, so it is read back from there.
 */
export type TranscriptFact =
  | { type: 'started'; id: string; kind: SessionWorkKind; label: string | null; at: string; until: string | null }
  | { type: 'ended'; ids: string[]; reason: string; at: string }
  | { type: 'seen'; ids: string[]; at: string }
  /** the main thread doing something (`active`), or its turn over (`ended`, `interrupted`) */
  | { type: 'turn'; phase: 'active' | 'ended' | 'interrupted'; at: string };

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
}

/** What one transcript's reader carries between reads. */
export interface ReaderState {
  /** tool_use id → the call, until its result is read */
  pending: Map<string, PendingTool>;
  /** one-shot scheduled prompts, which end when they fire */
  oneShotCrons: Set<string>;
}

export function newReaderState(): ReaderState {
  return { pending: new Map(), oneShotCrons: new Set() };
}

/** The id a session's /loop wake-up is kept under. There is at most one per session. */
export const wakeupId = (sessionId: string): string => `wake:${sessionId}`;
/** Scheduled prompts are numbered per process, so they are kept under the session's name too. */
export const cronId = (sessionId: string, id: string): string => `cron:${sessionId}:${id}`;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const clip = (v: unknown, n = 120): string | null => {
  const s = str(v);
  return s ? s.replace(/\s+/g, ' ').trim().slice(0, n) : null;
};

/**
 * Each <task-notification> in a piece of text, read one block at a time.
 *
 * One block at a time because a block can name several tasks ("3 background agents didn't finish
 * before the previous session ended"), and a monitor's event has no status at all — reading the
 * text as one stream matched an event's id to the status of the next notification along, which
 * ended a monitor that was still watching.
 */
export function notificationBlocks(text: string): Array<{ ids: string[]; status: string | null }> {
  const out: Array<{ ids: string[]; status: string | null }> = [];
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1]!;
    const ids = [...body.matchAll(/<task-id>([\w:-]+)<\/task-id>/g)].map((x) => x[1]!);
    if (!ids.length) continue;
    out.push({ ids, status: body.match(/<status>(\w+)<\/status>/)?.[1]?.toLowerCase() ?? null });
  }
  return out;
}

/** Ids of background tasks a piece of text says are over. Kept for callers that only need that. */
export function finishedTasks(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const note = notificationText(j);
    if (!note) continue;
    for (const b of notificationBlocks(note)) if (b.status && OVER.has(b.status)) ids.push(...b.ids);
  }
  return ids;
}

/**
 * The notification a transcript record carries, if it is one of the records Claude Code uses to
 * deliver them. Deliberately not "any text containing the tag": a tool result that prints a
 * transcript, or a tool's own description, carries the same words and says nothing about this
 * session's tasks.
 *
 * `queue-operation` is written the moment the task ends, even while the main thread is busy; the
 * `attachment` and the user entry are written when the model is shown it.
 */
function notificationText(j: Record<string, any>): string | null {
  if (j.type === 'queue-operation') return str(j.content);
  if (j.type === 'attachment') return j.attachment?.type === 'queued_command' ? str(j.attachment.prompt) : null;
  if (j.type === 'user' && !j.isSidechain) {
    const c = j.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
    if (j.origin?.kind === 'task-notification' || text.trimStart().startsWith('<task-notification>')) return text;
  }
  return null;
}

/** Facts in a tool's result: work it left running, or work it says is over. */
function toolFacts(tool: PendingTool, result: unknown, at: string, sessionId: string, state: ReaderState): TranscriptFact[] {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, any>;
  const input = tool.input;
  const describe = clip(input.description) ?? clip(input.command) ?? clip(input.prompt);

  if (STOP_TOOLS.has(tool.name)) {
    const id = str(input.task_id) ?? str(input.shell_id) ?? str(input.bash_id);
    return id ? [{ type: 'ended', ids: [id], reason: 'stopped by the session', at }] : [];
  }
  if (OUTPUT_TOOLS.has(tool.name)) {
    const id = str(input.task_id) ?? str(input.shell_id) ?? str(input.bash_id);
    if (!id) return [];
    const status = str(r.task?.status) ?? str(r.status);
    const over = (status && OVER.has(status.toLowerCase())) || typeof r.exitCode === 'number' || typeof r.exit_code === 'number';
    return [over ? { type: 'ended', ids: [id], reason: 'finished', at } : { type: 'seen', ids: [id], at }];
  }
  if (AGENT_TOOLS.has(tool.name)) {
    const id = str(r.agentId);
    if (!id) return [];
    const label = clip(input.description) ?? clip(input.subagent_type);
    if (r.isAsync === true || r.status === 'async_launched') return [{ type: 'started', id, kind: 'subagent', label, at, until: null }];
    // A foreground subagent's result is its end; SubagentStop says the same, when it arrives.
    return [{ type: 'ended', ids: [id], reason: 'finished', at }];
  }
  if (tool.name === 'Monitor') {
    const id = str(r.taskId);
    if (!id) return [];
    const timeout = typeof r.timeoutMs === 'number' ? r.timeoutMs : typeof input.timeout_ms === 'number' ? input.timeout_ms : null;
    const until = r.persistent === true || timeout === null ? null : new Date(Date.parse(at) + timeout).toISOString();
    return [{ type: 'started', id, kind: 'monitor', label: describe, at, until }];
  }
  if (tool.name === 'Workflow') {
    const id = str(r.taskId) ?? str(r.task_id) ?? str(r.backgroundTaskId) ?? str(r.runId);
    return id ? [{ type: 'started', id, kind: 'workflow', label: clip(r.name) ?? clip(input.name) ?? describe ?? 'workflow', at, until: null }] : [];
  }
  if (tool.name === 'ScheduleWakeup') {
    if (r.stopped === true) return [{ type: 'ended', ids: [wakeupId(sessionId)], reason: 'the loop was stopped', at }];
    if (typeof r.scheduledFor === 'number' && r.scheduledFor > 0) {
      const label = clip(input.reason) ?? clip(input.prompt) ?? 'loop wake-up';
      return [{ type: 'started', id: wakeupId(sessionId), kind: 'wakeup', label, at, until: new Date(r.scheduledFor).toISOString() }];
    }
    return [];
  }
  if (tool.name === 'CronCreate') {
    const id = str(r.id);
    if (!id) return [];
    if (r.recurring === false) state.oneShotCrons.add(id);
    const label = [clip(r.humanSchedule, 40) ?? clip(input.cron, 40), clip(input.prompt, 80)].filter(Boolean).join(': ') || 'scheduled prompt';
    return [{ type: 'started', id: cronId(sessionId, id), kind: 'cron', label, at, until: null }];
  }
  if (tool.name === 'CronDelete') {
    const id = str(input.id) ?? str(r.id);
    return id ? [{ type: 'ended', ids: [cronId(sessionId, id)], reason: 'deleted by the session', at }] : [];
  }
  // Any other tool that hands back a background handle — Bash and PowerShell with run_in_background.
  const bg = str(r.backgroundTaskId);
  return bg ? [{ type: 'started', id: bg, kind: 'shell', label: describe, at, until: null }] : [];
}

/**
 * What a tool's result says about work, read from a PostToolUse hook rather than the transcript.
 * The same reading as the transcript's, so the fast path and the backstop cannot disagree.
 */
export function toolResultFacts(tool: string | null, input: unknown, response: unknown, sessionId: string): TranscriptFact[] {
  if (!tool) return [];
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return toolFacts({ name: tool, input: i }, response, new Date().toISOString(), sessionId, newReaderState());
}

/**
 * What a run of complete transcript lines says, in order. Pure apart from `state`, which carries
 * tool calls whose results have not been read yet.
 */
export function transcriptFacts(text: string, sessionId: string, state: ReaderState = newReaderState()): TranscriptFact[] {
  const out: TranscriptFact[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 0x7b) continue;
    let j: Record<string, any>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const at = str(j.timestamp) ?? new Date().toISOString();

    const note = notificationText(j);
    if (note) {
      for (const b of notificationBlocks(note)) {
        if (b.status && OVER.has(b.status)) out.push({ type: 'ended', ids: b.ids, reason: b.status === 'completed' ? 'finished' : b.status, at });
        else out.push({ type: 'seen', ids: b.ids, at });
      }
    }
    // A subagent's own records say nothing about the main thread's turn.
    if (j.isSidechain) continue;

    if (j.type === 'assistant') {
      const content = Array.isArray(j.message?.content) ? j.message.content : [];
      for (const b of content) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
        state.pending.set(b.id, { name: String(b.name ?? ''), input: (b.input ?? {}) as Record<string, unknown> });
        if (state.pending.size > PENDING_TOOLS) state.pending.delete(state.pending.keys().next().value!);
      }
      // An API error or a usage-limit banner is written as an assistant message nobody generated.
      if (j.message?.model !== '<synthetic>' && !j.isApiErrorMessage) out.push({ type: 'turn', phase: 'active', at });
    } else if (j.type === 'user') {
      const c = j.message?.content;
      const blocks: any[] = Array.isArray(c) ? c : [];
      const text = typeof c === 'string' ? c : blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      if (text.startsWith(INTERRUPTED)) {
        out.push({ type: 'turn', phase: 'interrupted', at });
        continue;
      }
      let results = false;
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue;
        results = true;
        const tool = state.pending.get(b.tool_use_id);
        if (!tool) continue;
        state.pending.delete(b.tool_use_id);
        out.push(...toolFacts(tool, j.toolUseResult, at, sessionId, state));
      }
      // A tool result, or a prompt of any origin, means the turn is running. Meta records are not.
      if (results || (!j.isMeta && j.origin)) out.push({ type: 'turn', phase: 'active', at });
    } else if (j.type === 'system') {
      if (j.subtype === 'turn_duration') out.push({ type: 'turn', phase: 'ended', at });
      else if (j.subtype === 'scheduled_task_fire') {
        const task = str(j.taskId);
        if (/\/loop wakeup/i.test(String(j.content ?? ''))) out.push({ type: 'ended', ids: [wakeupId(sessionId)], reason: 'woke up', at });
        else if (task && state.oneShotCrons.delete(task)) out.push({ type: 'ended', ids: [cronId(sessionId, task)], reason: 'fired', at });
        out.push({ type: 'turn', phase: 'active', at });
      }
    }
  }
  return out;
}

/** Reads each transcript forward from where it last stopped. */
export class TranscriptReader {
  private readonly files = new Map<string, { offset: number; state: ReaderState }>();

  /** Facts from whatever the transcript gained since the last read of it. */
  read(file: string, sessionId: string): TranscriptFact[] {
    let fd: number | null = null;
    try {
      const size = fs.statSync(file).size;
      let entry = this.files.get(file);
      if (!entry) {
        entry = { offset: Math.max(0, size - FIRST_READ_BYTES), state: newReaderState() };
        this.files.set(file, entry);
      }
      if (entry.offset > size) entry.offset = 0; // rewritten
      if (entry.offset === size) return [];
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - entry.offset);
      fs.readSync(fd, buf, 0, buf.length, entry.offset);
      // Stop at the last complete line, so a record half-written now is read whole next time.
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) return [];
      entry.offset += end + 1;
      return transcriptFacts(buf.subarray(0, end).toString('utf8'), sessionId, entry.state);
    } catch {
      return [];
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  forget(file: string): void {
    this.files.delete(file);
  }
}

/**
 * A session's transcript found by its id, for a session whose hooks have not said where it is —
 * one that has been quiet since this daemon started, which is exactly the one most likely to be
 * showing a status that stopped being true while nobody was listening. Each root is a Claude Code
 * config directory; its `projects` holds one folder per starting directory.
 */
export function findTranscript(sessionId: string, configDirs: string[]): string | null {
  for (const dir of configDirs) {
    const projects = path.join(dir, 'projects');
    let names: string[];
    try {
      names = fs.readdirSync(projects);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(projects, name, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** Where Claude Code writes a subagent's own transcript, beside its session's. */
export function subagentTranscript(mainTranscript: string, agentId: string): string {
  return path.join(mainTranscript.replace(/\.jsonl$/i, ''), 'subagents', `agent-${agentId}.jsonl`);
}

/** Whether a file has grown since the last look, for work whose only sign of life is its transcript. */
export class GrowthWatch {
  private readonly sizes = new Map<string, number>();

  grew(file: string): boolean {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return false;
    }
    const before = this.sizes.get(file);
    this.sizes.set(file, size);
    return before !== undefined && size > before;
  }

  forget(file: string): void {
    this.sizes.delete(file);
  }
}
