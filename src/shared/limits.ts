/**
 * Reading a usage limit off a terminal screen.
 *
 * Claude Code reports a rate limit properly through the StopFailure hook, and that is what
 * Switchboard acts on. This is the fallback for the cases the hook does not cover — a subagent that
 * hit the limit while the parent carried on, a version that stops without firing it — and it is
 * only ever a guess about somebody else's user interface.
 *
 * Which matters, because the screen belongs to the session: an agent reading a log, grepping source
 * or printing this very file puts the words "usage limit reached" in front of the scanner, and a
 * session working perfectly well then reported itself out of usage. So the phrase alone is not
 * enough — the line it sits on has to look like something a person was told, rather than something
 * a machine printed.
 */

export const LIMIT_RE =
  /(usage limit reached|you['’]ve (hit|reached) your (usage |session |weekly |5-hour )?limit|(5-hour|weekly|session) limit reached|limit reached[^\n]{0,40}resets)/i;

/**
 * Whether this line is machine output rather than prose addressed to the operator.
 *
 * Timestamps, log levels, JSON punctuation, shell operators and file extensions are all things that
 * turn up constantly in what an agent prints and never in a banner Claude Code draws in a box.
 */
export function looksLikeOutput(line: string): boolean {
  return (
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(line) ||
    /\b(WARN|INFO|ERROR|DEBUG|TRACE)\b/.test(line) ||
    /["'][:,]|[{}[\]]["']|=>|\|\||&&|\$\(|\/\*|\*\//.test(line) ||
    /\.(ts|tsx|js|jsx|py|json|log|md|sh)\b/.test(line) ||
    /^\s*(\d+[:|]|[+-]{3}\s|[|+-]{2})/.test(line)
  );
}

export type BannerScan =
  /** nothing in this screenful says anything about a limit */
  | { kind: 'none' }
  /** the words are there, but on a line the session printed rather than was shown */
  | { kind: 'ignored'; line: string; restFrom: number }
  /** the session has been told it is out of usage */
  | { kind: 'limit'; text: string };

/** What a screenful of terminal output says about usage, if anything. */
export function scanForLimit(tail: string): BannerScan {
  const m = tail.match(LIMIT_RE);
  if (!m) return { kind: 'none' };
  const at = m.index ?? 0;
  const start = tail.lastIndexOf('\n', at) + 1;
  const end = tail.indexOf('\n', at);
  const line = tail.slice(start, end === -1 ? undefined : end);
  if (looksLikeOutput(line)) return { kind: 'ignored', line, restFrom: end === -1 ? tail.length : end + 1 };
  return { kind: 'limit', text: m[0] };
}
