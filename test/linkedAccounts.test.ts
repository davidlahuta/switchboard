import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AccountStore } from '../src/daemon/accounts.ts';
import { Bus } from '../src/daemon/bus.ts';
import { Db } from '../src/daemon/db.ts';
import { DESK_PATHS, fillDeskPaths, googleEntry, ms365Entry, playwrightEntry, type McpPaths } from '../src/accounts/mcpHost.ts';
import { accountIdFrom, accountServer, MS_CONSUMER_TENANT, msAuthority } from '../src/shared/accounts.ts';

/** An ID token as a provider returns it: only the claims matter here. */
const idToken = (claims: Record<string, unknown>): string => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/** A fake Google and Microsoft: answers token requests from a script, and records them. */
function provider() {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const replies: Array<{ status?: number; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? '')) });
    const r = replies.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, replies, fetchFn };
}

async function store() {
  const db = new Db(':memory:');
  const p = provider();
  const accounts = new AccountStore(db, new Bus(), { fetch: p.fetchFn });
  return { db, accounts, ...p };
}

const stateOf = (url: string): string => new URL(url).searchParams.get('state')!;

describe('accounts: apps and signing in', () => {
  it('offers nothing until an app is set up, and Google needs its secret too', async () => {
    const { accounts } = await store();
    assert.deepEqual(accounts.snapshot().enabled, { google: false, microsoft: false });
    assert.throws(() => accounts.start({ provider: 'microsoft', kind: 'personal', origin: 'http://127.0.0.1:4477' }), /Configure the Microsoft app/);
    await assert.rejects(accounts.saveApp('google', { clientId: '1-x.apps.googleusercontent.com' }), /client secret is required/);
    await accounts.saveApp('microsoft', { clientId: '00000000-1111-2222-3333-444444444444' });
    assert.equal(accounts.enabled('microsoft'), true);
    await assert.rejects(accounts.saveApp('microsoft', { clientId: 'not-a-guid' }), /GUID/);
  });

  it('sends the browser back to localhost on the desk, and to the hub address through the proxy', async () => {
    const { accounts } = await store();
    assert.match(accounts.redirectFor('google', 'http://127.0.0.1:4477'), /^http:\/\/localhost:\d+\/oauth\/google\/callback$/);
    assert.equal(accounts.redirectFor('microsoft', 'https://hub.example.ts.net'), 'https://hub.example.ts.net/oauth/microsoft/callback');
  });

  it('adds a personal Microsoft account with PKCE, and a sign-in cannot be replayed', async () => {
    const { accounts, calls, replies } = await store();
    await accounts.saveApp('microsoft', { clientId: '00000000-1111-2222-3333-444444444444' });
    const { url } = accounts.start({ provider: 'microsoft', kind: 'personal', origin: 'http://127.0.0.1:4477' });
    const u = new URL(url);
    assert.equal(u.pathname, '/consumers/oauth2/v2.0/authorize');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('scope')!, /offline_access .*Mail\.Send/);
    replies.push({
      body: {
        access_token: 'AT1',
        refresh_token: 'RT1',
        expires_in: 3600,
        scope: 'Mail.ReadWrite Mail.Send',
        id_token: idToken({ oid: 'o-1', tid: MS_CONSUMER_TENANT, preferred_username: 'Me@Outlook.com', name: 'Me' }),
      },
    });
    const a = await accounts.callback('microsoft', new URLSearchParams({ state: stateOf(url), code: 'C1' }));
    assert.equal(a.email, 'me@outlook.com');
    assert.equal(a.kind, 'personal');
    assert.equal(a.tenant, 'consumers');
    assert.equal(a.server, 'ms-me');
    assert.ok(calls[0].form.get('code_verifier'), 'the verifier went with the code');
    assert.equal(calls[0].form.get('client_secret'), null, 'a public client sends no secret');
    await assert.rejects(accounts.callback('microsoft', new URLSearchParams({ state: stateOf(url), code: 'C1' })), /expired or was already used/);
  });

  it('files a Google account as Workspace when it has a hosted domain, with a refresh token always asked for', async () => {
    const { accounts, replies } = await store();
    await accounts.saveApp('google', { clientId: '1-x.apps.googleusercontent.com', clientSecret: 's3cret' });
    const { url } = accounts.start({ provider: 'google', origin: 'http://127.0.0.1:4477' });
    const u = new URL(url);
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('prompt'), 'consent');
    replies.push({ body: { access_token: 'ya29.A', refresh_token: 'GRT', expires_in: 3599, id_token: idToken({ sub: 'g-1', email: 'ops@example.com', hd: 'example.com' }) } });
    const a = await accounts.callback('google', new URLSearchParams({ state: stateOf(url), code: 'C' }));
    assert.equal(a.kind, 'workspace');
    assert.equal(a.server, 'google-ops');
  });
});

describe('accounts: tokens for sessions', () => {
  async function withAccount() {
    const s = await store();
    await s.accounts.saveApp('microsoft', { clientId: '00000000-1111-2222-3333-444444444444' });
    const { url } = s.accounts.start({ provider: 'microsoft', kind: 'work', origin: 'http://127.0.0.1:4477' });
    s.replies.push({ body: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 60, id_token: idToken({ oid: 'o-2', tid: 'tenant-a', preferred_username: 'me@example.com' }) } });
    const a = await s.accounts.callback('microsoft', new URLSearchParams({ state: stateOf(url), code: 'C' }));
    s.db.run("INSERT INTO runs (id, name, cwd, session_id, subscription_id, status, created_at) VALUES ('r1', 'one', '/x', 's1', 'sub', 'running', '2026-01-01')");
    s.db.run("INSERT INTO runs (id, name, cwd, session_id, subscription_id, status, created_at) VALUES ('r2', 'two', '/x', 's2', 'sub', 'running', '2026-01-01')");
    s.accounts.setRunAccounts('r1', [a.id]);
    return { ...s, a };
  }

  it('refreshes against the account tenant and keeps the rotated refresh token', async () => {
    const { accounts, a, calls, replies, db } = await withAccount();
    assert.equal(msAuthority('work', 'tenant-a'), 'tenant-a');
    const ticket = accounts.issueTicket('r1');
    // The token from sign-in expires within the margin, so this refreshes.
    replies.push({ body: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 } });
    const t = await accounts.mintForRun({ ticket, account: a.server, deskId: null });
    assert.equal(t.accessToken, 'AT2');
    const refresh = calls.at(-1)!;
    assert.match(refresh.url, /\/tenant-a\/oauth2\/v2\.0\/token$/);
    assert.equal(refresh.form.get('refresh_token'), 'RT1');
    // Kept sealed where there is DPAPI; a store reading it back fresh refreshes with the new one.
    const p2 = provider();
    const fresh = new AccountStore(db, new Bus(), { fetch: p2.fetchFn });
    p2.replies.push({ body: { access_token: 'AT3', refresh_token: 'RT3', expires_in: 3600 } });
    await fresh.accessToken(a.id);
    assert.equal(p2.calls[0].form.get('refresh_token'), 'RT2');
    // And the next one comes from the cache, without asking Microsoft.
    const before = calls.length;
    await accounts.mintForRun({ ticket, account: a.id, deskId: null });
    assert.equal(calls.length, before);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM account_mints WHERE account_id = ?', a.id)!.n, 2);
  });

  it('gives tokens only to the session the ticket belongs to, on its own desk, for its own accounts', async () => {
    const { accounts, a, db } = await withAccount();
    const t1 = accounts.issueTicket('r1');
    const t2 = accounts.issueTicket('r2');
    await assert.rejects(accounts.mintForRun({ ticket: t2, account: a.id, deskId: null }), /not started with the account/);
    await assert.rejects(accounts.mintForRun({ ticket: 'tnope', account: a.id, deskId: null }), /unknown or ended/);
    await assert.rejects(accounts.mintForRun({ ticket: t1, account: a.id, deskId: 'desk-b' }), /another desk/);
    db.run("UPDATE runs SET status = 'exited' WHERE id = 'r1'");
    await assert.rejects(accounts.mintForRun({ ticket: t1, account: a.id, deskId: null }), /unknown or ended/);
    // A respawn makes a new ticket; the old one stops working.
    db.run("UPDATE runs SET status = 'running' WHERE id = 'r1'");
    accounts.issueTicket('r1');
    await assert.rejects(accounts.mintForRun({ ticket: t1, account: a.id, deskId: null }), /unknown or ended/);
  });

  it('marks an account for reconnecting when its grant is gone, and says so to the session', async () => {
    const { accounts, a, replies } = await withAccount();
    let told = '';
    accounts.onNeedsReconsent = (x) => (told = x.email);
    const ticket = accounts.issueTicket('r1');
    replies.push({ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000: revoked' } });
    await assert.rejects(accounts.mintForRun({ ticket, account: a.id, deskId: null }), /needs to be reconnected/);
    assert.equal(accounts.get(a.id)!.status, 'needs-reconsent');
    assert.equal(told, 'me@example.com');
  });

  it('carries a rename into the sessions that have the account', async () => {
    const { accounts, a } = await withAccount();
    accounts.rename(a.id, 'work');
    assert.deepEqual(
      accounts.runAccounts('r1').map((x) => x.server),
      ['ms-work'],
    );
    assert.throws(() => accounts.rename('work', 'Bad Name!'), /lowercase/);
  });
});

describe('accounts: MCP entries in a session', () => {
  const local: McpPaths = { node: 'C:\\node.exe', cli: 'C:\\sb\\cli.ts', preload: 'file:///C:/sb/pre.mjs', playwright: 'C:\\mcp\\pw\\cli.js', ms365: 'C:\\mcp\\ms\\index.js', googlePort: '4497', logs: 'C:/mcp/logs' };

  it('runs Playwright isolated, and through npx at the same version until it is installed', () => {
    assert.deepEqual(playwrightEntry(local), { type: 'stdio', command: 'C:\\node.exe', args: ['C:\\mcp\\pw\\cli.js', '--isolated'] });
    const npx = playwrightEntry({ ...local, playwright: null }) as { args: string[] };
    assert.match(npx.args.join(' '), /@playwright\/mcp@\d+\.\d+\.\d+ --isolated/);
  });

  it('gives each Microsoft account a server that takes its token from Switchboard and keeps none', () => {
    const e = ms365Entry(local, { account: 'ms-work', ticket: 'tABC', clientId: 'cid', work: true, run: 'r1' }) as { args: string[]; env: Record<string, string> };
    assert.deepEqual(e.args, ['--import', 'file:///C:/sb/pre.mjs', 'C:\\mcp\\ms\\index.js', '--org-mode']);
    assert.equal(e.env.SWITCHBOARD_ACCOUNT_TICKET, 'tABC');
    assert.equal(e.env.MS365_MCP_USE_KEYTAR, '0');
    assert.equal(e.env.MS365_MCP_LOG_DIR, 'C:/mcp/logs/r1');
    assert.equal(ms365Entry({ ...local, ms365: null }, { account: 'ms-work', ticket: 't', clientId: 'c', work: false, run: 'r1' }), null, 'not before it is installed');
  });

  it('points each Google account at the shared server, with a headers helper for its token', () => {
    const e = googleEntry(local, { account: 'google-me', ticket: 'tXYZ' }) as { url: string; headersHelper: string };
    assert.equal(e.url, 'http://127.0.0.1:4497/mcp');
    assert.match(e.headersHelper, /"C:\\node\.exe" "C:\\sb\\cli\.ts" account-token --account google-me --header --ticket tXYZ$/);
  });

  it('lets a satellite put its own paths into what the hub wrote', () => {
    const file = JSON.stringify({
      mcpServers: {
        playwright: playwrightEntry(DESK_PATHS),
        'ms-work': ms365Entry(DESK_PATHS, { account: 'ms-work', ticket: 't1', clientId: 'c', work: false, run: 'r9' }),
        'google-me': googleEntry(DESK_PATHS, { account: 'google-me', ticket: 't1' }),
      },
    });
    const desk = { node: '/usr/bin/node', cli: '/home/me/sb/src/cli.ts', preload: 'file:///home/me/sb/pre.mjs', playwright: '/d/pw/cli.js', ms365: '/d/ms/index.js', googlePort: '4500', logs: '/d/logs', url: 'http://127.0.0.1:4478' };
    const filled = JSON.parse(fillDeskPaths(file, desk));
    assert.doesNotMatch(JSON.stringify(filled), /\{\{sb:/);
    assert.deepEqual(filled.mcpServers.playwright.args, ['/d/pw/cli.js', '--isolated']);
    assert.equal(filled.mcpServers['ms-work'].env.MS365_MCP_LOG_DIR, '/d/logs/r9');
    assert.equal(filled.mcpServers['ms-work'].env.SWITCHBOARD_URL, 'http://127.0.0.1:4478');
    assert.equal(filled.mcpServers['google-me'].url, 'http://127.0.0.1:4500/mcp');
    // A desk that has neither installed yet: Playwright through npx, Microsoft left out, the rest kept.
    const bare = JSON.parse(fillDeskPaths(file, { ...desk, playwright: null, ms365: null }));
    assert.equal(bare.mcpServers.playwright.args[0], '-y');
    assert.equal(bare.mcpServers['ms-work'], undefined);
    assert.ok(bare.mcpServers['google-me']);
    assert.equal(fillDeskPaths('{"plain":true}', desk), '{"plain":true}');
  });

  it('names accounts and their servers predictably', () => {
    assert.equal(accountIdFrom('David.Lahuta@outlook.com'), 'david-lahuta');
    assert.equal(accountServer('microsoft', 'work'), 'ms-work');
    assert.equal(accountServer('google', 'me'), 'google-me');
  });
});
