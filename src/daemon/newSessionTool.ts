import path from 'node:path';
import { newSessionDefaults, newSessionFormFromTool, newSessionRequest } from '../shared/newSession.ts';
import type { CreateRunRequest, Run, Settings } from '../shared/types.ts';

export interface NewSessionCaller {
  /** The worktree the calling agent is in, which a session it starts defaults to. */
  worktree: string | null;
  /** Where relative folders it names are taken from. */
  cwd: string | null;
}

export interface NewSessionDeps {
  settings: () => Settings;
  subscriptions: () => Array<{ id: string; label: string; ready: boolean }>;
  create: (req: CreateRunRequest) => Promise<Run>;
}

/**
 * The request an agent's sb_new_session arguments become. The same defaults and the same builder
 * as the New session dialog (src/shared/newSession.ts); the only thing decided here is what an agent
 * has and a person in the dialog does not — where "here" is. The dialog opens on a folder the person
 * can see; an agent's own worktree is the equivalent, and a relative path is read from where it is.
 */
export function newSessionToolRequest(args: Record<string, unknown>, caller: NewSessionCaller, deps: Pick<NewSessionDeps, 'settings' | 'subscriptions'>): CreateRunRequest {
  const here = caller.worktree ?? caller.cwd ?? process.cwd();
  const cwdArg = typeof args.cwd === 'string' && args.cwd.trim() ? path.resolve(caller.cwd ?? here, args.cwd.trim()) : here;
  const form = newSessionFormFromTool({ ...args, cwd: cwdArg }, newSessionDefaults(deps.settings(), here));
  // An agent knows subscriptions by the labels on the board, not by id.
  const ref = form.subscriptionId.trim();
  const byLabel = deps.subscriptions().find((s) => s.id !== ref && s.label.toLowerCase() === ref.toLowerCase());
  if (byLabel) form.subscriptionId = byLabel.id;
  return newSessionRequest(form);
}

/** Start the session and say what happened in terms the calling agent can act on. */
export async function runNewSessionTool(args: Record<string, unknown>, caller: NewSessionCaller, deps: NewSessionDeps): Promise<{ run: Run; text: string }> {
  const req = newSessionToolRequest(args, caller, deps);
  let run: Run;
  try {
    run = await deps.create(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const subs = deps.subscriptions().filter((s) => s.ready).map((s) => `${s.label} (${s.id})`);
    throw new Error(`${message}${/subscription/i.test(message) && subs.length ? ` Logged-in subscriptions: ${subs.join(', ')}, or 'auto'.` : ''}`);
  }
  const task = typeof args.task === 'string' && args.task.trim() ? args.task.trim() : null;
  const text = [
    `Started "${run.name}" (run ${run.id}, session ${run.sessionId}) in ${run.cwd} on ${run.subscriptionLabel}.`,
    task
      ? 'Your task goes to it as a request from you as soon as it joins the board; its answer comes back to you like any reply.'
      : `It joins the board as "${run.name}" once it starts; give it work with sb_send.`,
  ].join(' ');
  return { run, text };
}
