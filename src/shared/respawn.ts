/**
 * How a respawn is described wherever it is shown — a toast, a badge, a repo timeline, a terminal
 * banner. One place, so the web and the daemon never call the same event two different things.
 */
import type { RespawnKind, RespawnTrigger } from './types.ts';

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
