import { DAEMON_URL } from '../config.ts';

/*
 * `switchboard account-token --account <server or id> [--header] [--ticket <t>] [--url <u>]`
 *
 * Asks Switchboard (the daemon here, or the desk agent on a satellite, which relays it) for a fresh
 * access token for one account of the session that holds the ticket. Claude Code runs it as the
 * headersHelper of a session's Google MCP server, with --header, and prints what it says to the
 * server: `{"Authorization":"Bearer ..."}`. It runs again whenever the server turns a token away, so
 * a token that expires an hour in is replaced without the session noticing.
 *
 * The token goes from here to the MCP server and nowhere else: never into the conversation.
 */
export async function accountToken(f: Record<string, string | true>): Promise<void> {
  const s = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
  const account = s(f.account) ?? process.env.SWITCHBOARD_ACCOUNT ?? '';
  const ticket = s(f.ticket) ?? process.env.SWITCHBOARD_ACCOUNT_TICKET ?? '';
  const base = (s(f.url) ?? process.env.SWITCHBOARD_URL ?? DAEMON_URL).replace(/\/+$/, '');
  if (!account || !ticket) {
    process.stderr.write('Usage: switchboard account-token --account <id> --ticket <ticket> [--header]\n');
    process.exit(2);
  }
  let res: Response;
  try {
    res = await fetch(`${base}/api/cred/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, account }),
      signal: AbortSignal.timeout(9_000),
    });
  } catch (err) {
    process.stderr.write(`switchboard: cannot reach ${base}: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string; expiresAt?: number; error?: string };
  if (!res.ok || !body.accessToken) {
    process.stderr.write(`switchboard: no token for ${account}: ${body.error ?? res.status}\n`);
    process.exit(1);
  }
  process.stdout.write(f.header === true ? JSON.stringify({ Authorization: `Bearer ${body.accessToken}` }) : JSON.stringify({ accessToken: body.accessToken, expiresAt: body.expiresAt }));
}
