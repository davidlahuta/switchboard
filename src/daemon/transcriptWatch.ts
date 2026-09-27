import { logger } from '../log.ts';
import type { AgentStatus } from '../shared/types.ts';
import type { Coordinator } from './coord.ts';
import { findTranscript, GrowthWatch, subagentTranscript, type TranscriptFact, TranscriptReader } from './tasknotes.ts';

const log = logger('transcript');

/** A start older than this, read from a transcript, is history rather than work; see apply. */
const STALE_START_MS = 3 * 3600_000;
/** How long a session whose transcript could not be found waits before it is looked for again. */
const LOCATE_RETRY_MS = 5 * 60_000;

/** What the watch tells the rest of the daemon; RunManager in production, a recorder in tests. */
export interface WatchSink {
  onWorkChanged(sessionId: string): void;
  onWorkSettled(sessionId: string): void;
  /** the session's turn is over, and no hook said so */
  onIdle(sessionId: string): void;
}

/** How a turn record moves a status, when it is newer than the status. */
export function turnStatus(current: AgentStatus, phase: 'active' | 'ended' | 'interrupted'): AgentStatus | null {
  if (phase === 'active') return current === 'idle' || current === 'limited' || current === 'waiting' ? 'working' : null;
  return current === 'working' || current === 'waiting' ? 'idle' : null;
}

/**
 * The transcript, read back to keep a session's status and work true when the hooks are not.
 *
 * Hooks arrive at once and say most things, and are kept as the fast path. What they miss:
 *
 * - An Esc fires no Stop, so a session stopped by hand stayed "working" until its next prompt.
 * - A turn started by a task notification, a channel message or a /loop wake-up fires no
 *   UserPromptSubmit, so a session busy with the result it was waiting for read as idle.
 * - A hook sent while the daemon was restarting is gone, and with it a Stop, a SubagentStop, or the
 *   PostToolUse that was the only record of a background shell.
 * - A monitor, a workflow, a wake-up and a scheduled prompt have no hook at all.
 *
 * Every one of those is written to the transcript, so each session's is read forward every few
 * seconds and whatever it says that the board does not already know is applied. A record only
 * moves a status when it is newer than the status's last change, so the reader cannot undo what a
 * hook said a moment later about something the transcript has not caught up with.
 */
export class TranscriptWatch {
  private readonly reader = new TranscriptReader();
  private readonly growth = new GrowthWatch();
  private readonly known = new Map<string, string>();
  /** session id → when to look for its transcript again */
  private readonly missed = new Map<string, number>();

  private readonly coord: Coordinator;
  private readonly sink: WatchSink;

  private readonly configDirs: () => string[];

  /** `configDirs` are the Claude Code config directories sessions run under: home, and each profile. */
  constructor(coord: Coordinator, sink: WatchSink, configDirs: () => string[] = () => []) {
    this.coord = coord;
    this.sink = sink;
    this.configDirs = configDirs;
  }

  /** Every live session, and the subagents each still has open. */
  poll(): void {
    this.locate();
    const live = this.coord.transcripts();
    const seen = new Set<string>();
    for (const a of live) {
      seen.add(a.id);
      this.read(a.id, a.transcript);
    }
    for (const [id, file] of this.known) {
      if (seen.has(id)) continue;
      this.known.delete(id);
      this.reader.forget(file);
    }
  }

  /**
   * Find the transcripts of sessions no hook has spoken for since this daemon started. Looked for
   * by id across every config directory, and a session not found is not looked for again for a
   * while: it is a directory listing per project, cheap once and wasteful every three seconds.
   */
  private locate(): void {
    const at = Date.now();
    for (const id of this.coord.withoutTranscript()) {
      if ((this.missed.get(id) ?? 0) > at) continue;
      const file = findTranscript(id, this.configDirs());
      if (file) {
        this.coord.setTranscript(id, file);
        this.missed.delete(id);
      } else this.missed.set(id, at + LOCATE_RETRY_MS);
    }
  }

  /** One session's transcript, now: what the hooks call on the way through. */
  read(sessionId: string, file: string): void {
    const previous = this.known.get(sessionId);
    if (previous !== file) {
      if (previous) this.reader.forget(previous);
      this.known.set(sessionId, file);
    }
    try {
      this.apply(sessionId, this.reader.read(file, sessionId));
      this.watchSubagents(sessionId, file);
    } catch (err) {
      log.warn('could not read a transcript', { session: sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * A subagent that is thinking calls no tool and fires no hook, sometimes for many minutes; its
   * transcript growing is the only sign it is alive, and without it a long think was given up on.
   */
  private watchSubagents(sessionId: string, file: string): void {
    for (const w of this.coord.liveWork(sessionId)) {
      if (w.kind !== 'subagent') continue;
      if (this.growth.grew(subagentTranscript(file, w.id))) this.coord.workSeen(w.id);
    }
  }

  /** Apply what was read, or what a hook said in the same terms. */
  apply(sessionId: string, facts: TranscriptFact[]): void {
    if (!facts.length) return;
    let changed = false;
    let settled = false;
    let turn: Extract<TranscriptFact, { type: 'turn' }> | null = null;
    let latest: string | null = null;
    for (const f of facts) {
      if (!latest || f.at > latest) latest = f.at;
      switch (f.type) {
        case 'started':
          /*
           * The first read of a transcript goes back a stretch, and finds work that was over long
           * before this daemon was — its end outside the stretch, its row gone with retention.
           * Nothing still running started that long ago, and a wake-up already past is not coming.
           */
          if (Date.now() - Date.parse(f.at) > STALE_START_MS) break;
          if (f.until && Date.parse(f.until) < Date.now() && (f.kind === 'wakeup' || f.kind === 'monitor')) break;
          // A wake-up booked again replaces the last one, which is the only kind that comes back.
          if (this.coord.workStarted(sessionId, { id: f.id, kind: f.kind, label: f.label, until: f.until, at: f.at }, { reopen: f.kind === 'wakeup' || f.kind === 'cron' })) {
            changed = true;
            log.info('session work read from the transcript', { session: sessionId, kind: f.kind, id: f.id });
          }
          break;
        case 'ended':
          for (const id of f.ids) if (this.coord.workEnded(id, f.reason)) settled = true;
          break;
        case 'seen':
          for (const id of f.ids) this.coord.workSeen(id);
          break;
        case 'turn':
          turn = f;
          break;
      }
    }
    // The turn first: a status with no status_at yet is dated by last_seen, which the touch moves.
    if (turn) this.applyTurn(sessionId, turn);
    if (latest) this.coord.touch(sessionId, latest);
    if (settled) this.sink.onWorkSettled(sessionId);
    else if (changed) this.sink.onWorkChanged(sessionId);
  }

  private applyTurn(sessionId: string, turn: Extract<TranscriptFact, { type: 'turn' }>): void {
    const a = this.coord.agent(sessionId);
    if (!a || a.status === 'offline') return;
    const since = a.status_at ?? a.last_seen;
    if (turn.at <= since) return;
    const next = turnStatus(a.status, turn.phase);
    if (!next) return;
    log.info('status corrected from the transcript', { session: sessionId, from: a.status, to: next, record: turn.phase, at: turn.at });
    this.coord.setStatus(sessionId, next, next === 'idle' ? null : undefined);
    if (next === 'idle') this.sink.onIdle(sessionId);
  }
}
