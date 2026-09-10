/**
 * Turning a typed command line into `string[]` for `CreateRunRequest.args`.
 *
 * The daemon spawns claude directly (no shell), so this splitter deliberately does only what a
 * shell's *word splitting* does — whitespace separates tokens, quotes group them — and nothing
 * else: no variable expansion, no globbing, no command substitution, no operators. Anything the
 * user types that looks like `$HOME`, `*` or `&&` is passed through verbatim as part of a token,
 * which is what someone typing `--append-system-prompt "cost: $5"` expects.
 */

export interface Argv {
  args: string[];
  /** A quote was opened and never closed; the tail is still tokenised, but the input is suspect. */
  unterminated: boolean;
}

/**
 * Split a command line into argv.
 *
 * Rules (POSIX-ish, quoting only):
 * - Runs of whitespace separate tokens.
 * - `'…'` is literal: nothing inside is special, not even a backslash.
 * - `"…"` groups; inside it `\"` and `\\` are escapes, every other character is literal.
 * - Outside quotes, `\` escapes only a quote, a space or another backslash. Everywhere else it
 *   stays a plain character — this runs on Windows, where `--add-dir C:\src\shared` is the common
 *   case and a POSIX shell's "escape anything" rule would silently eat the separators.
 * - Quotes are word-joining, not word-making: `--dir="a b"` is one token `--dir=a b`, and an
 *   empty quoted string `""` is a real, empty argument.
 */
/** Characters a backslash may escape outside quotes — deliberately not "anything". */
const ESCAPABLE = new Set(['"', "'", '\\', ' ', '\t']);

export function parseArgv(input: string): Argv {
  const args: string[] = [];
  let token = '';
  // Tracked separately from `token.length` so that `""` yields an empty argument rather than none.
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (!started) return;
    args.push(token);
    token = '';
    started = false;
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (quote === "'") {
      if (c === "'") quote = null;
      else token += c;
      continue;
    }

    if (quote === '"') {
      if (c === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        token += input[++i];
        continue;
      }
      if (c === '"') quote = null;
      else token += c;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === '\\' && ESCAPABLE.has(input[i + 1])) {
      token += input[++i];
      started = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      flush();
      continue;
    }
    token += c;
    started = true;
  }
  flush();

  return { args, unterminated: quote !== null };
}

/** Just the tokens — use `parseArgv` when the unterminated-quote hint matters. */
export function splitArgs(input: string): string[] {
  return parseArgv(input).args;
}

/**
 * Render argv back into a line that `parseArgv` round-trips. Only quotes what has to be quoted —
 * a lone backslash needs no quoting under the rule above, which keeps Windows paths readable.
 */
export function joinArgs(args: string[]): string {
  return args.map((a) => (a === '' || /["'\s]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');
}

/**
 * Arguments the daemon manages itself and rejects with a 400. Mirrored here only to warn *before*
 * submitting; the daemon stays the authority and its message is what the dialog shows on failure.
 *
 * Two kinds, rejected for two reasons: the first block would break what makes a session *hosted*
 * (identity, coordination, resuming it elsewhere); the second block has its own control in the
 * dialog, so passing it here would apply the same setting twice.
 */
const RESERVED = new Set([
  '--session-id',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--mcp-config',
  '--settings',
  '--worktree',
  '-w',
  '--from-pr',
  '--teleport',
  '--model',
  '--name',
  '--dangerously-skip-permissions',
]);

/** The reserved flags present in `args`, deduped, in the order they appear. */
export function reservedArgs(args: string[]): string[] {
  const seen = new Set<string>();
  for (const a of args) {
    const flag = a.split('=')[0];
    if (RESERVED.has(flag)) seen.add(flag);
  }
  return [...seen];
}
