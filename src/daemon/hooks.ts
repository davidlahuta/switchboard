import { logger } from '../log.ts';
import { type Coordinator, editedPath } from './coord.ts';
import type { RunManager } from './runs.ts';

const log = logger('hooks');

type Payload = Record<string, any>;

function context(event: string, parts: Array<string | null | undefined>): object {
  const text = parts.filter((p): p is string => !!p).join('\n\n');
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
}

/** Claude Code HTTP hook endpoint: presence, conflict checks, lazy message delivery, swap signals. */
export function createHookHandler(coord: Coordinator, runs: RunManager) {
  return (event: string, p: Payload, runHeader: string | undefined): object => {
    const sid = typeof p.session_id === 'string' ? p.session_id : null;
    const cwd = typeof p.cwd === 'string' ? p.cwd : null;
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
          return context('SessionStart', [coord.digest(sid), coord.piggyback(sid)]);
        }
        case 'UserPromptSubmit':
          coord.setStatus(sid, 'working', null);
          return context('UserPromptSubmit', [coord.piggyback(sid)]);
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
