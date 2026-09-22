// What starting a session asks for, in one place: the web UI's New session dialog and the sb_new_session
// tool an agent calls both build their request here, from the same defaults, so the two cannot
// drift into starting different sessions for the same choices. test/newSession.test.ts holds them to it.

import type { CreateRunRequest, Settings } from './types.ts';

export const COMPACT_MIN = 20_000;
export const COMPACT_MAX = 990_000;
export const COMPACT_STEP = 10_000;

/** Every choice the New session dialog offers, as it holds them before they become a request. */
export interface NewSessionForm {
  /** Folder to start in. */
  cwd: string;
  /** Subscription id, or 'auto' for the one with the most headroom. */
  subscriptionId: string;
  /** '' lets the daemon name it after the folder. */
  name: string;
  /** '' for none. Ignored when resuming: a resumed session is already somewhere. */
  worktree: string;
  /** '' for a new conversation, or the GUID of one to resume. */
  resumeSessionId: string;
  /** '' leaves it to the default model from Settings. */
  model: string;
  autoCompact: boolean;
  autoCompactTokens: number;
  skipPermissions: boolean;
  diffPanel: boolean;
  autoSwap: boolean;
  continueOnResume: boolean;
  /** Extra claude arguments for this session only. */
  args: string[];
}

/** The fields of NewSessionForm, in the order the dialog shows them. */
export const NEW_SESSION_FIELDS = [
  'cwd',
  'subscriptionId',
  'name',
  'worktree',
  'resumeSessionId',
  'model',
  'autoCompact',
  'autoCompactTokens',
  'skipPermissions',
  'diffPanel',
  'autoSwap',
  'continueOnResume',
  'args',
] as const satisfies ReadonlyArray<keyof NewSessionForm>;

/** What the dialog starts from when it opens, and what an agent gets for anything it leaves out. */
export function newSessionDefaults(settings: Settings, cwd: string): NewSessionForm {
  return {
    cwd,
    subscriptionId: 'auto',
    name: '',
    worktree: '',
    resumeSessionId: '',
    model: '',
    autoCompact: settings.defaultAutoCompact,
    autoCompactTokens: settings.defaultAutoCompactTokens,
    skipPermissions: settings.defaultSkipPermissions,
    diffPanel: settings.defaultDiffPanel,
    autoSwap: settings.autoSwap,
    continueOnResume: settings.continueOnResume,
    args: [],
  };
}

export function clampCompactTokens(v: number): number {
  if (!Number.isFinite(v)) return COMPACT_MIN;
  return Math.min(COMPACT_MAX, Math.max(COMPACT_MIN, Math.round(v)));
}

/** The request a form becomes: blanks left out, so the daemon applies its own defaults to them. */
export function newSessionRequest(form: NewSessionForm): CreateRunRequest {
  const resume = form.resumeSessionId.trim();
  const args = form.args.filter((a) => a.trim() !== '');
  return {
    cwd: form.cwd.trim(),
    subscriptionId: form.subscriptionId.trim() || 'auto',
    autoSwap: form.autoSwap,
    autoCompact: form.autoCompact,
    autoCompactTokens: clampCompactTokens(form.autoCompactTokens),
    skipPermissions: form.skipPermissions,
    diffPanel: form.diffPanel,
    continueOnResume: form.continueOnResume,
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(form.worktree.trim() && !resume ? { worktree: form.worktree.trim() } : {}),
    // Sessions are addressed by GUID; a title next to it is only a label.
    ...(resume ? { resumeSessionId: resume } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(args.length ? { args } : {}),
  };
}

/**
 * The sb_new_session tool's parameters: one per dialog field, under the same name, plus `task`.
 *
 * `task` is the one thing an agent needs that a person does not: a person types the first message
 * into the terminal the dialog opens, an agent has no terminal to type into. It is delivered to the
 * new session as a request from the agent that started it, as soon as the session joins the board.
 */
export const NEW_SESSION_TOOL_PROPERTIES: Record<(typeof NEW_SESSION_FIELDS)[number] | 'task', { type: string; description: string; items?: { type: string } }> = {
  cwd: { type: 'string', description: 'Folder to start in. Relative paths are from your working directory; default is the root of the worktree you are in.' },
  subscriptionId: { type: 'string', description: "Subscription id or label, or 'auto' (default) for the one with the most headroom." },
  name: { type: 'string', description: 'Session name. Default: named after the folder.' },
  worktree: { type: 'string', description: 'Create a new git worktree with this name for the session. Ignored when resuming.' },
  resumeSessionId: { type: 'string', description: 'GUID of an existing conversation to resume instead of starting a new one.' },
  model: { type: 'string', description: 'Model id. Default: the default model from Switchboard settings.' },
  autoCompact: { type: 'boolean', description: 'Compact the conversation automatically. Default from Switchboard settings.' },
  autoCompactTokens: { type: 'integer', description: `Context tokens at which to auto-compact (${COMPACT_MIN}-${COMPACT_MAX}). Default from Switchboard settings.` },
  skipPermissions: { type: 'boolean', description: 'Run tools without approval prompts. Default from Switchboard settings.' },
  diffPanel: { type: 'boolean', description: "Open Claude Code's /diff panel beside the conversation. Default from Switchboard settings." },
  autoSwap: { type: 'boolean', description: 'Move to another subscription when this one hits a limit. Default from Switchboard settings.' },
  continueOnResume: { type: 'boolean', description: 'Tell the session to carry on whenever it comes back after a restart or swap. Default from Switchboard settings.' },
  args: { type: 'array', items: { type: 'string' }, description: 'Extra claude arguments for this session only.' },
  task: { type: 'string', description: 'What the new session should do: delivered to it as a request from you once it joins the board.' },
};

/**
 * An agent's tool arguments as a form: every field the agent gave, of the right type, over the
 * defaults the dialog would have opened with. Anything else is ignored rather than guessed at.
 */
export function newSessionFormFromTool(args: Record<string, unknown>, defaults: NewSessionForm): NewSessionForm {
  const form: NewSessionForm = { ...defaults, args: [...defaults.args] };
  const target = form as unknown as Record<string, unknown>;
  for (const field of NEW_SESSION_FIELDS) {
    const v = args[field];
    const want = typeof defaults[field];
    if (field === 'args') {
      if (Array.isArray(v)) form.args = v.filter((a): a is string => typeof a === 'string');
    } else if (want === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) target[field] = v;
    } else if (typeof v === want) {
      target[field] = v;
    }
  }
  return form;
}
