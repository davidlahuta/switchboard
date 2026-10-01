import { logger } from '../log.ts';
import { type Coordinator, editedPath } from './coord.ts';
import type { RunManager } from './runs.ts';
import { SCHEDULED_WORK, SPENDING_WORK } from '../shared/types.ts';
import { LOCAL_DESK } from '../shared/desk.ts';
import { toolResultFacts } from './tasknotes.ts';
import type { TranscriptWatch } from './transcriptWatch.ts';

const log = logger('hooks');

type Payload = Record<string, any>;

function context(event: string, parts: Array<string | null | undefined>, extra?: Record<string, unknown>): object {
  const text = parts.filter((p): p is string => !!p).join('\n\n');
  const out: Record<string, unknown> = { hookEventName: event, ...extra };
  if (text) out.additionalContext = text;
  return Object.keys(out).length > 1 ? { hookSpecificOutput: out } : {};
}

/**
 * Tools that stop and wait for the operator. PreToolUse fires for them like any other tool, and
 * reading that as "working" showed a session asking a question as busy for as long as nobody
 * answered it.
 */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Why a session started, from SessionStart's `source`: whether what it had running survived. */
export function workSurvivesStart(source: string | null): 'all' | 'running' | 'none' {
  // /compact is the same process carrying on: everything it had running is still running.
  if (source === 'compact') return 'all';
  /*
   * A resumed conversation is a new process. Claude Code hands background shells, workflows and
   * subagents over to it when it can and says so; the ones it could not are reported as stopped
   * ("didn't finish before the previous session ended"), which the transcript watch reads. So those
   * are left to that report. A wake-up or a scheduled prompt lived in the old process's memory and
   * went with it.
   */
  if (source === 'resume') return 'running';
  return 'none';
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

/**
 * Claude Code HTTP hook endpoint: presence, conflict checks, lazy message delivery, swap signals.
 *
 * `deskId` is the satellite a hook was relayed from, or null for a session beside the hub. A
 * satellite's paths are paths on that machine: its transcript arrives as desk://, which `deskPath`
 * turns into the hub's mirror of it, and its working directory is only ever asked about on that desk.
 */
export function createHookHandler(coord: Coordinator, runs: RunManager, watch: TranscriptWatch, deskPath: (deskId: string, p: string | null) => string | null = (_d, p) => p) {
  return async (event: string, p: Payload, runHeader: string | undefined, deskId: string | null = null): Promise<object> => {
    const sid = typeof p.session_id === 'string' ? p.session_id : null;
    /*
     * Present only when the hook came from inside a subagent, and the reason a session's status can
     * be trusted at all: without it a subagent's tool calls read as the main thread working, which
     * looks like protection and is not. It leaves the session reading idle for exactly as long as a
     * subagent goes without calling a tool, which for a thinking subagent is its whole life.
     */
    const agentId = typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null;
    const cwd = typeof p.cwd === 'string' ? p.cwd : null;
    const reported = typeof p.transcript_path === 'string' ? p.transcript_path : null;
    const transcript = deskId ? deskPath(deskId, reported) : reported;
    if (!sid) return {};
    const runId = runHeader && !runHeader.startsWith('$') ? runHeader : null;
    /*
     * Which run this is about is asked of the conversation rather than taken from the header, which
     * is an environment variable and can belong to another session entirely; see hookOwner. A hook
     * that carries a run id and is owned by nobody gets nothing here: no board row under the run's
     * name, no status, no messages meant for the session it failed to become. Either it is a resume
     * that came up on a conversation of its own, which RunManager has already stopped and said so,
     * or it is another claude carrying a run id in its environment and speaking for a terminal it is
     * not in.
     */
    const owner = runs.ownerOfHook(runId, sid, { kind: 'hook', event, source: typeof p.source === 'string' ? p.source : null });
    if (runId && owner === null) return {};
    // A run belongs to one desk, and only hooks from that desk speak for it.
    if (owner && runs.deskOfRun(owner) !== (deskId ?? LOCAL_DESK)) return {};

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
        deskId,
      });
    }

    /*
     * The transcript says what no hook does — a background task ending, a turn a notification
     * started, an Esc — and TranscriptWatch reads it every few seconds regardless. Reading it here
     * as well, before this hook's own word is applied, keeps the board current to the hook and
     * leaves the hook the last say on the status. Only the main thread's hooks carry the path of
     * the session's own transcript.
     */
    if (!agentId && transcript && event !== 'SessionStart') {
      coord.setTranscript(sid, transcript);
      watch.read(sid, transcript);
    }

    try {
      switch (event) {
        case 'SessionStart': {
          const source = typeof p.source === 'string' ? p.source : null;
          const survives = workSurvivesStart(source);
          if (survives !== 'all') coord.forgetPid(sid);
          if (survives === 'none') coord.endSessionWork(sid, 'the session started again');
          else if (survives === 'running') coord.endSessionWork(sid, 'the session started again', SCHEDULED_WORK);
          if (transcript) {
            coord.setTranscript(sid, transcript);
            // A resume appends to the same file; read on from here, not from before the restart.
            watch.read(sid, transcript);
          }
          if (cwd) await coord.setCwd(sid, cwd, deskId);
          coord.setStatus(sid, 'idle');
          runs.onSessionStart(sid, cwd);
          runs.syncModel(sid, transcript);
          return context('SessionStart', [coord.digest(sid), coord.piggyback(sid)], titleSync(runs, sid, p));
        }
        case 'UserPromptSubmit':
          coord.setStatus(sid, 'working', null);
          // Answering a session is having read what it said. A board message or a task notification
          // handed to it is not an answer from the operator.
          if (!/^\s*<(channel|task-notification)\b/.test(typeof p.prompt === 'string' ? p.prompt : '')) runs.operatorPrompted(sid);
          return context('UserPromptSubmit', [coord.piggyback(sid)], titleSync(runs, sid, p));
        case 'PreToolUse': {
          // A subagent's tool call says the subagent is alive, not that the main thread is working.
          // The edit checks below still apply: it is the same tree, under the session's name.
          const tool = typeof p.tool_name === 'string' ? p.tool_name : null;
          if (agentId) coord.workSeen(agentId);
          // Asking the operator is waiting for them, whatever else PreToolUse means.
          else coord.setStatus(sid, tool && ASKING_TOOLS.has(tool) ? 'waiting' : 'working', tool);
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
          // Work the call left running, or says is over: a shell, a monitor, a subagent, a wake-up.
          watch.apply(sid, toolResultFacts(tool, p.tool_input, p.tool_response, sid));
          const file = editedPath(p.tool_name, p.tool_input);
          return context('PostToolUse', [file && tool ? await coord.recordEdit(sid, file, tool) : null, coord.piggyback(sid)]);
        }
        case 'SubagentStart': {
          const type = typeof p.agent_type === 'string' ? p.agent_type : null;
          if (agentId) {
            // A subagent sent another message starts again under the same id.
            coord.workStarted(sid, { id: agentId, kind: 'subagent', label: type }, { reopen: true });
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
            // subscription, and the swap that fixes the limit must not sit waiting on work that is
            // already dead. A shell, a monitor or a wake-up spends nothing and carries on regardless.
            coord.endSessionWork(sid, 'the session ran out of usage', SPENDING_WORK);
            runs.onLimit(sid, String(p.error_message ?? 'rate limit'), 'hook');
          }
          return {};
        }
        case 'Notification': {
          const t = String(p.notification_type ?? '');
          if (['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(t)) coord.setStatus(sid, 'waiting');
          // Sitting at the prompt is idle, except when what is on screen is a question for the operator.
          else if (t === 'idle_prompt' && coord.agent(sid)?.status !== 'waiting') coord.setStatus(sid, 'idle');
          return {};
        }
        case 'SessionEnd':
          coord.endSessionWork(sid, 'the session ended');
          coord.markOffline(sid, String(p.reason ?? 'ended'));
          return {};
        case 'CwdChanged':
          if (cwd) {
            await coord.setCwd(sid, cwd, deskId);
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
