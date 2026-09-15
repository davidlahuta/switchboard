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
    case 'rebalance':
      return 'rebalancing the desk';
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
 * Whether a respawn for this reason should wait for the session's background shells and monitors.
 *
 * A shell is cheap to re-run and expensive to lose at the wrong moment, and which of the two it is
 * depends on why the session is being taken. A session that has run out of usage, or whose terminal
 * has died, cannot make progress where it is — its shell is doing it no good, and waiting would only
 * keep it stuck. Everything else is a respawn nobody needed this minute: a rebalance, an update, a
 * swap chasing headroom, a new terminal asked for by hand. Those wait.
 *
 * They wait because a session that has started a long run in the background and ended its turn is
 * not finished; it is waiting to be woken when the run reports, and only the process that started
 * the run can be woken. A rebalance taken the second a turn ended killed a recipe six minutes into a
 * twelve-minute run, and the session came back with a plan that depended on a result nobody would
 * ever deliver. The wait is bounded all the same: a shell nothing mentions is given up on after
 * three quarters of an hour of silence, so a dev server left running holds nothing off for ever.
 */
export function waitsForShells(trigger: RespawnTrigger): boolean {
  return trigger !== 'limit' && trigger !== 'rescue' && trigger !== 'revive';
}

/**
 * Whether the session can be taken down now, turn and everything it started included.
 *
 * The turn ending is only half of it. A subagent launched in the background outlives the turn that
 * launched it — measurably: the parent's Stop hook arrives while the subagent is still thinking, and
 * only its SubagentStop says the work is really over. Taking the session in that window throws away
 * everything the subagent has spent, so a live subagent counts as busy whatever the reason.
 *
 * Background shells and monitors count when `trigger` says the respawn can wait for them; see
 * waitsForShells. Without a trigger — a caller asking whether a session looks busy, not whether to
 * take it — they do not.
 */
export function readyForRespawn(input: { status: AgentStatus | undefined | null; work: SessionWork[]; trigger?: RespawnTrigger }): boolean {
  if (!safeToRespawn(input.status)) return false;
  const shellsHold = input.trigger !== undefined && waitsForShells(input.trigger);
  return !input.work.some((w) => w.kind === 'subagent' || shellsHold);
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
