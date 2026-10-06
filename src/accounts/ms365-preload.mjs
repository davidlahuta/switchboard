// Loaded into the Microsoft 365 MCP server (@softeria/ms-365-mcp-server) with `node --import`, by
// the MCP entry Switchboard writes for each account of a session (see ms365Entry in mcpHost.ts).
//
// The server's own token handling either signs in by itself and keeps a token cache, or takes one
// access token it cannot refresh. Neither fits: the refresh token stays in Switchboard. So its
// AuthManager is given a getToken that asks Switchboard for this account's current access token,
// with the session's ticket, and keeps it until shortly before it expires. Nothing is written to
// disk, and the installed package is not modified.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const account = process.env.SWITCHBOARD_ACCOUNT ?? '';
const ticket = process.env.SWITCHBOARD_ACCOUNT_TICKET ?? '';
const base = (process.env.SWITCHBOARD_URL || 'http://127.0.0.1:4477').replace(/\/+$/, '');
const MARGIN_MS = 2 * 60_000;

// The server's own entry script is argv[1]; its AuthManager is the default export of auth.js beside it.
const authUrl = pathToFileURL(path.join(path.dirname(process.argv[1] ?? '.'), 'auth.js')).href;
const AuthManager = (await import(authUrl)).default;

let cached = null;
let inflight = null;

async function fetchToken(force) {
  if (!force && cached && cached.expiresAt - Date.now() > MARGIN_MS) return cached.accessToken;
  inflight ??= (async () => {
    const res = await fetch(`${base}/api/cred/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, account }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.accessToken) throw new Error(`Switchboard would not give a token for ${account}: ${body.error ?? res.status}`);
    cached = { accessToken: body.accessToken, expiresAt: Number(body.expiresAt) || Date.now() + 30 * 60_000 };
    return cached.accessToken;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

if (AuthManager?.prototype && account && ticket) {
  AuthManager.prototype.getToken = function getToken(forceRefresh = false) {
    return fetchToken(forceRefresh);
  };
  AuthManager.prototype.getTokenForAccount = function getTokenForAccount() {
    return fetchToken(false);
  };
  // Its token cache and login state are not ours to read or write.
  AuthManager.prototype.loadTokenCache = async function loadTokenCache() {};
  AuthManager.prototype.saveTokenCache = async function saveTokenCache() {};
} else {
  process.stderr.write('switchboard: ms-365 preload could not take over token handling (no account, ticket or AuthManager)\n');
}
