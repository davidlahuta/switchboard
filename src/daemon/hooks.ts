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
  return (event: string, p: Payload, runHeader: string | undefined): object => {
    const sid = typeof p.session_id === 'string' ? p.session_id : null;
    const cwd = typeof p.cwd === 'string' ? p.cwd : null;
    const transcript = typeof p.transcript_path === 'string' ? p.transcript_path : null;
    if (!sid) return {};
    const runId = runHeader && !runHeader.startsWith('$') ? runHeader : null;
    if (runId) runs.rebind(runId, sid);

    if (!coord.agent(sid)) {
      if (!cwd) return {};
      const run = runId ? runs.row(runId) : runs.bySession(sid);
      coord.registerAgent({
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
          if (cwd) coord.setCwd(sid, cwd);
          coord.setStatus(sid, 'idle');
          runs.onSessionStart(sid, cwd);
          runs.syncModel(sid, transcript);
          return context('SessionStart', [coord.digest(sid), coord.piggyback(sid)], titleSync(runs, sid, p));
        }
        case 'UserPromptSubmit':
          coord.setStatus(sid, 'working', null);
          return context('UserPromptSubmit', [coord.piggyback(sid)], titleSync(runs, sid, p));
        case 'PreToolUse': {
          coord.setStatus(sid, 'working', typeof p.tool_name === 'string' ? p.tool_name : null);
          const file = editedPath(p.tool_name, p.tool_input);
          if (!file) return {};
          const verdict = coord.preEdit(sid, file);
          if (verdict.deny) {
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.deny } };
          }
          return context('PreToolUse', [verdict.context]);
        }
        case 'PostToolUse': {
          const tool = typeof p.tool_name === 'string' ? p.tool_name : null;
          coord.setStatus(sid, 'working', tool);
          const file = editedPath(p.tool_name, p.tool_input);
          return context('PostToolUse', [file && tool ? coord.recordEdit(sid, file, tool) : null, coord.piggyback(sid)]);
        }
        case 'Stop': {
          if (!p.stop_hook_active) {
            const reason = coord.stopBlockReason(sid);
            if (reason) return { decision: 'block', reason };
          }
          coord.setStatus(sid, 'idle', null);
          runs.onIdle(sid);
          runs.syncModel(sid, transcript);
          return {};
        }
        case 'StopFailure': {
          const limited = p.error_type === 'rate_limit';
          coord.setStatus(sid, limited ? 'limited' : 'idle', null);
          if (limited) runs.onLimit(sid, String(p.error_message ?? 'rate limit'), 'hook');
          return {};
        }
        case 'Notification': {
          const t = String(p.notification_type ?? '');
          if (['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'].includes(t)) coord.setStatus(sid, 'waiting');
          else if (t === 'idle_prompt') coord.setStatus(sid, 'idle');
          return {};
        }
        case 'SessionEnd':
          coord.markOffline(sid, String(p.reason ?? 'ended'));
          return {};
        case 'CwdChanged':
          if (cwd) {
            coord.setCwd(sid, cwd);
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
