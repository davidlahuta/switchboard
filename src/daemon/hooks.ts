import { logger } from '../log.ts';
import { type Coordinator, editedPath } from './coord.ts';
import type { RunManager } from './runs.ts';

const log = logger('hooks');

type Payload = Record<string, any>;

function context(event: string, parts: Array<string | null | undefined>, extra?: Record<string, unknown>): object {
  const text = parts.filter((p): p is string => !!p).join('\n\n');
  const out: Record<string, unknown> = { hookEventName: event, ...extra };
  if (text) out.additionalContext = text;
  return Object.keys(out).length > 1 ? { hookSpecificOutput: out } : {};
}

/** Tools that hand back a handle to something still running after they return. */
const OUTPUT_TOOLS = new Set(['BashOutput', 'TaskOutput']);
const STOP_TOOLS = new Set(['KillShell', 'TaskStop']);

/** The id a tool call is about, under any of the names Claude Code has used for it. */
export function taskIdOf(input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const key of ['task_id', 'agentId', 'bash_id', 'shell_id']) {
    const v = i[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/**
 * Work a tool call has left running behind it.
 *
 * A background shell and a monitor announce themselves only here, in the result of the call that
 * started them: `backgroundTaskId` is the handle, and nothing fires when they end. So they are
 * recorded from the response rather than from a hook of their own, and given up on later if nothing
 * mentions them again. Subagents are better served, by SubagentStart and SubagentStop, and are
 * recorded from those instead.
 */
export function startedWork(tool: string | null, response: unknown): { id: string; kind: 'shell' | 'monitor' } | null {
  const r = (response ?? {}) as Record<string, unknown>;
  const id = typeof r.backgroundTaskId === 'string' ? r.backgroundTaskId : null;
  if (!id) return null;
  return { id, kind: tool === 'Monitor' ? 'monitor' : 'shell' };
}

/** Whether a peek at a background task says it is over. */
export function looksFinished(response: unknown): boolean {
  const r = (response ?? {}) as Record<string, unknown>;
  if (typeof r.status === 'string') return ['completed', 'failed', 'killed', 'exited'].includes(r.status);
  return typeof r.exitCode === 'number' || typeof r.exit_code === 'number';
}

/** Enough of what was started to recognise it in a list: the command, or what it was watching. */
function describeWork(input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const text = i.description ?? i.command;
  return typeof text === 'string' ? text.slice(0, 120) : null;
}

/**
 * The name Switchboard holds for the session, when the session is carrying a different one.
 * SessionStart and UserPromptSubmit are the two events that can both report and set the title,
 * which is what keeps the two names from drifting apart.
 */
function titleSync(runs: RunManager, sid: string, p: Payload): Record<string, unknown> | undefined {
  const push = runs.syncTitle(sid, typeof p.session_title === 'string' ? p.session_title : null);
  return push ? { sessionTitle: push } : undefined;
}

/** Claude Code HTTP hook endpoint: presence, conflict checks, lazy message delivery, swap signals. */
export function createHookHandler(coord: Coordinator, runs: RunManager) {
  return async (event: string, p: Payload, runHeader: string | undefined): Promise<object> => {
    const sid = typeof p.session_id === 'string' ? p.session_id : null;
    /*
     * Present only when the hook came from inside a subagent, and the reason a session's status can
     * be trusted at all: without it a subagent's tool calls read as the main thread working, which
     * looks like protection and is not. It leaves the session reading idle for exactly as long as a
     * subagent goes without calling a tool, which for a thinking subagent is its whole life.
     */
    const agentId = typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null;
    const cwd = typeof p.cwd === 'string' ? p.cwd : null;
    const transcript = typeof p.transcript_path === 'string' ? p.transcript_path : null;
    if (!sid) return {};
    const runId = runHeader && !runHeader.startsWith('$') ? runHeader : null;
    // A session the run disowns — a resume that came up on a conversation of its own — gets nothing
    // here: no board row under the run's name, no status, no messages meant for the session it
    // failed to become. RunManager has already stopped it and said so.
    if (runId && !runs.rebind(runId, sid)) return {};

    /*
     * A session we have never heard of that is telling us it has ended has nothing to join. Claude
     * Code runs for reasons that are not conversations — a version check, an auth probe, an update —
     * and those fire a lone SessionEnd; registering on it put a row on the board for a session that
     * never existed, in whatever directory the process happened to start in.
     */
    if (!coord.agent(sid) && event !== 'SessionEnd') {
      if (!cwd) return {};
      const run = runId ? runs.row(runId) : runs.bySession(sid);
      await coord.registerAgent({
        sessionId: sid,
        cwd,
        runId: run?.id ?? null,
        subscriptionId: run?.subscription_id ?? null,
        hasChannel: run ? true : undefined,
        name: run?.name ?? null,
      });
    }

    try {
      switch (event) {
        case 'SessionStart': {
          coord.forgetPid(sid);
          // Whatever the last process had running died with it; this one starts with nothing.
          coord.endSessionWork(sid, 'the session started again');
          if (cwd) await coord.setCwd(sid, cwd);
          coord.setStatus(sid, 'idle');
          runs.onSessionStart(sid, cwd);
          runs.syncModel(sid, transcript);
          return context('SessionStart', [coord.digest(sid), coord.piggyback(sid)], titleSync(runs, sid, p));
        }
        case 'UserPromptSubmit':
          coord.setStatus(sid, 'working', null);
          return context('UserPromptSubmit', [coord.piggyback(sid)], titleSync(runs, sid, p));
        case 'PreToolUse': {
          // A subagent's tool call says the subagent is alive, not that the main thread is working.
          // The edit checks below still apply: it is the same tree, under the session's name.
          if (agentId) coord.workSeen(agentId);
          else coord.setStatus(sid, 'working', typeof p.tool_name === 'string' ? p.tool_name : null);
          const file = editedPath(p.tool_name, p.tool_input);
          if (!file) return {};
          const verdict = await coord.preEdit(sid, file);
          if (verdict.deny) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.deny } };
          }
          return context('PreToolUse', [verdict.context]);
        }
        case 'PostToolUse': {
          const tool = typeof p.tool_name === 'string' ? p.tool_name : null;
          if (agentId) coord.workSeen(agentId);
          else coord.setStatus(sid, 'working', tool);
          const started = startedWork(tool, p.tool_response);
          if (started) {
            coord.workStarted(sid, { ...started, label: describeWork(p.tool_input) });
            runs.onWorkChanged(sid);
          }
          const about = taskIdOf(p.tool_input);
          if (about && tool && STOP_TOOLS.has(tool)) coord.workEnded(about, 'stopped by the session');
          else if (about && tool && OUTPUT_TOOLS.has(tool)) {
            if (looksFinished(p.tool_response)) coord.workEnded(about, 'finished');
            else coord.workSeen(about);
          }
          const file = editedPath(p.tool_name, p.tool_input);
          return context('PostToolUse', [file && tool ? await coord.recordEdit(sid, file, tool) : null, coord.piggyback(sid)]);
        }
        case 'SubagentStart': {
          const type = typeof p.agent_type === 'string' ? p.agent_type : null;
          if (agentId) {
            coord.workStarted(sid, { id: agentId, kind: 'subagent', label: type });
            runs.onWorkChanged(sid);
          }
          return {};
        }
        case 'SubagentStop': {
          // The one moment a session that looked idle for the last twenty minutes genuinely becomes
          // idle, so anything queued behind it is told to look again.
          if (agentId && coord.workEnded(agentId, 'finished')) runs.onWorkSettled(sid);
          return {};
        }
        case 'Stop': {
          if (!p.stop_hook_active) {
            const reason = coord.stopBlockReason(sid);
            if (reason) return { decision: 'block', reason };
          }
          coord.setStatus(sid, 'idle', null);
          // It got to the end of a turn under its own power, so whatever stopped it before is over.
          runs.onTurnEnded(sid);
          runs.onIdle(sid);
          runs.syncModel(sid, transcript);
          return {};
        }
        case 'StopFailure': {
          const limited = p.error_type === 'rate_limit';
          coord.setStatus(sid, limited ? 'limited' : 'idle', null);
          /*
           * Every failed turn, not only the ones about usage. An overloaded API, a network blip, an
           * error Claude Code could not carry on from — the session stops with its work half done
           * and nothing else here is watching for it: no terminal died, so nothing revives it; no
           * usage moved, so nothing swaps it. This is the only mark that it stopped for a reason
           * nobody chose.
           */
          if (!limited) runs.onTurnFailed(sid, String(p.error_type ?? 'an error'));
          if (limited) {
            // The limit that stopped the main thread stops its subagents too: they draw on the same
            // subscription. Nothing will announce their end, so it is announced for them, or the
            // swap that fixes the limit would sit waiting on work that is already dead.
            coord.endSessionWork(sid, 'the session ran out of usage');
            runs.onLimit(sid, String(p.error_message ?? 'rate limit'), 'hook');
          }
          return {};
        }
        case 'Notification': {
          const t = String(p.notification_type ?? '');
          if (['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(t)) coord.setStatus(sid, 'waiting');
          else if (t === 'idle_prompt') coord.setStatus(sid, 'idle');
          return {};
        }
        case 'SessionEnd':
          coord.endSessionWork(sid, 'the session ended');
          coord.markOffline(sid, String(p.reason ?? 'ended'));
          return {};
        case 'CwdChanged':
          if (cwd) {
            await coord.setCwd(sid, cwd);
            runs.onCwd(sid, cwd);
          }
          return {};
        default:
          return {};
      }
    } catch (err) {
      log.error(`hook ${event} failed`, err);
      return {};
    }
  };
}
