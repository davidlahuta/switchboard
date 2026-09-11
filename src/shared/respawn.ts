/**
 * How a respawn is described wherever it is shown — a toast, a badge, a repo timeline, a terminal
 * banner. One place, so the web and the daemon never call the same event two different things.
 */
import type { AgentStatus, RespawnKind, RespawnTrigger, SessionWork, SessionWorkKind } from './types.ts';

/** Short enough for a badge, and the words an operator would use for it. */
export function triggerLabel(trigger: RespawnTrigger): string {
  switch (trigger) {
    case 'manual':
      return 'you asked';
    case 'update':
      return 'claude update';
    case 'limit':
      return 'usage limit';
    case 'proactive':
      return 'usage headroom';
    case 'rescue':
      return 'usage came back';
    case 'revive':
      return 'its terminal died';
  }
}

/** What is about to happen to the session, as a phrase that reads after its name. */
export function kindLabel(kind: RespawnKind): string {
  switch (kind) {
    case 'swap':
      return 'subscription swap';
    case 'restart':
      return 'restart';
    case 'relaunch':
      return 'new terminal';
  }
}

/**
 * Whether the session's own turn is over. Idle is the plain case; a session that stopped on a usage
 * limit has already lost its turn, so taking it is the fix rather than the cost; and a status of
 * undefined means no hook has ever spoken for this session, so there is nothing here to protect.
 *
 * Everything else — working, starting, waiting on a permission prompt — is a turn worth keeping.
 */
export function safeToRespawn(status: AgentStatus | undefined | null): boolean {
  return status === undefined || status === null || status === 'idle' || status === 'limited';
}

/**
 * Whether the session can be taken down now, turn and everything it started included.
 *
 * The turn ending is only half of it. A subagent launched in the background outlives the turn that
 * launched it — measurably: the parent's Stop hook arrives while the subagent is still thinking, and
 * only its SubagentStop says the work is really over. Taking the session in that window throws away
 * everything the subagent has spent, which is the most expensive thing Switchboard can do by
 * accident, so a live subagent counts as busy exactly as a running turn does.
 *
 * Background shells and monitors deliberately do not. A dev server started this morning would
 * otherwise hold off a restart for ever, and unlike a subagent it costs nothing but a re-run.
 */
export function readyForRespawn(input: { status: AgentStatus | undefined | null; work: SessionWork[] }): boolean {
  return safeToRespawn(input.status) && !input.work.some((w) => w.kind === 'subagent');
}

/** "2 subagents, 1 shell" — what a session still has running, in the order that matters. */
export function workSummary(work: SessionWork[]): string {
  const order: SessionWorkKind[] = ['subagent', 'shell', 'monitor'];
  const words: Record<SessionWorkKind, [string, string]> = {
    subagent: ['subagent', 'subagents'],
    shell: ['background shell', 'background shells'],
    monitor: ['monitor', 'monitors'],
  };
  return order
    .map((kind) => [kind, work.filter((w) => w.kind === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${words[kind][n === 1 ? 0 : 1]}`)
    .join(', ');
}
