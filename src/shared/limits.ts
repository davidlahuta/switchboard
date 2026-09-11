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
  /(usage limit reached|you['’]ve (hit|reached) your [a-z0-9 -]{0,24}limit|(5-hour|weekly|session|spend) limit reached|limit reached[^\n]{0,40}resets|session limit resets|monthly spend limit)/i;

/**
 * What kind of ceiling the session ran into.
 *
 * Not a detail. A five-hour or weekly window is something the usage endpoint reports, so a claim
 * about one can be checked before it is acted on. A spend cap is not in that endpoint at all — it
 * is the account's own limit on what it will pay for beyond the plan — so checking a spend limit
 * against window percentages rejects it every time, which is how a session sat stopped from one in
 * the morning until seven with full windows and nothing to spend them on.
 */
export type LimitCause = 'window' | 'spend';

const SPEND_RE = /(spend limit|usage-credits|monthly spend|credit balance|out of credits)/i;

export function causeOf(text: string): LimitCause {
  return SPEND_RE.test(text) ? 'spend' : 'window';
}

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
  | { kind: 'limit'; text: string; cause: LimitCause };

/** What a screenful of terminal output says about usage, if anything. */
export function scanForLimit(tail: string): BannerScan {
  const m = tail.match(LIMIT_RE);
  if (!m) return { kind: 'none' };
  const at = m.index ?? 0;
  const start = tail.lastIndexOf('\n', at) + 1;
  const end = tail.indexOf('\n', at);
  const line = tail.slice(start, end === -1 ? undefined : end);
  if (looksLikeOutput(line)) return { kind: 'ignored', line, restFrom: end === -1 ? tail.length : end + 1 };
  return { kind: 'limit', text: m[0], cause: causeOf(line) };
}

/**
 * Whether a model-scoped weekly window binds a session running `model`.
 *
 * The account-wide seven-day window counts every model; a scoped one is a second, narrower ceiling
 * on top of it, and the API says so — it arrives as a `weekly_scoped` limit carrying the model it
 * is about. So a subscription whose Fable week is spent is spent *for Fable*: a session on Sonnet
 * has the whole seven-day allowance still in front of it and no reason to be moved or held back.
 * Reading the two as one number is how a desk with usage left refuses to place a session.
 *
 * A session whose model is not known is not held to a scoped window. It might be on that model, but
 * the account-wide windows are what we actually know, and stranding a session on a guess costs more
 * than the swap it would take to move it if the guess was wrong.
 */
export function scopedBinds(label: string, model: string | null | undefined): boolean {
  if (!model) return false;
  const id = model.toLowerCase().replace(/[^a-z0-9]/g, '');
  const words = label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !GENERIC_SCOPE_WORDS.has(w) && !/^\d/.test(w));
  return words.length > 0 && words.some((w) => id.includes(w));
}

/** Words in a scope's name that say nothing about which model it is. */
const GENERIC_SCOPE_WORDS = new Set(['claude', 'model', 'weekly', 'limit', 'scoped', 'the', 'usage']);
