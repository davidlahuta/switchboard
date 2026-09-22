import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { CredentialSync, type CredsHolder, parseLogin, RENEW_AHEAD_MS, writeCredentials } from '../src/daemon/credsync.ts';

const HOUR = 3600_000;
const login = (token: string, expiresInMs: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: Date.now() + expiresInMs, subscriptionType: 'max', ...extra } });

describe('each session\'s own copy of its login', () => {
  let root: string;
  let holders: CredsHolder[];
  /** Which account each token belongs to, as the API would say. */
  let accounts: Map<string, string>;
  let renewed: string[];
  let sync: CredentialSync;
  const canonical = (sub: string): string => path.join(root, 'profiles', sub, '.credentials.json');
  const tokenIn = (file: string): string | null => parseLogin(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)?.accessToken ?? null;
  const copyOf = (runId: string): string => path.join(sync.dirFor(runId), '.credentials.json');
  /** What a running claude does when it renews: writes the new login into the file it reads. */
  const sessionRenews = (runId: string, token: string, account: string): void => {
    accounts.set(token, account);
    fs.writeFileSync(copyOf(runId), login(token, 8 * HOUR));
  };

  const make = (): CredentialSync =>
    new CredentialSync(
      {
        holders: () => holders,
        canonicalFile: (sub) => (sub === 'missing' ? null : canonical(sub)),
        subscriptionOfAccount: (email) => ({ 'a@x': 'A', 'b@x': 'B' })[email] ?? null,
        accountOf: async (token) => accounts.get(token) ?? null,
        renew: async (sub) => {
          renewed.push(sub);
        },
      },
      path.join(root, 'creds'),
    );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-creds-'));
    writeCredentials(canonical('A'), login('a1', 6 * HOUR));
    writeCredentials(canonical('B'), login('b1', 6 * HOUR));
    accounts = new Map([
      ['a1', 'a@x'],
      ['b1', 'b@x'],
    ]);
    holders = [];
    renewed = [];
    sync = make();
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('gives a session a copy of its subscription\'s login, in a directory of its own', () => {
    const dir = sync.assign('run1', 'A');
    assert.equal(dir, sync.dirFor('run1'));
    assert.equal(tokenIn(copyOf('run1')), 'a1');
    assert.equal(sync.assign('run2', 'missing'), null, 'no login to copy: the session stays on its profile\'s own file');
  });

  it('moves a session to another account by rewriting only its copy', () => {
    sync.assign('run1', 'A');
    sync.assign('run2', 'A');
    sync.assign('run1', 'B');
    assert.equal(tokenIn(copyOf('run1')), 'b1');
    assert.equal(tokenIn(copyOf('run2')), 'a1', 'the other session on A is untouched');
    assert.equal(tokenIn(canonical('A')), 'a1');
    assert.equal(tokenIn(canonical('B')), 'b1');
  });

  it('carries a renewal of the canonical login out to every session on it', async () => {
    sync.assign('run1', 'A');
    sync.assign('run2', 'A');
    holders = [
      { runId: 'run1', subscriptionId: 'A' },
      { runId: 'run2', subscriptionId: 'A' },
    ];
    writeCredentials(canonical('A'), login('a2', 8 * HOUR));
    await sync.tick();
    assert.equal(tokenIn(copyOf('run1')), 'a2');
    assert.equal(tokenIn(copyOf('run2')), 'a2');
  });

  it('carries a renewal made by a session home, and out to the other sessions on the account', async () => {
    sync.assign('run1', 'A');
    sync.assign('run2', 'A');
    holders = [
      { runId: 'run1', subscriptionId: 'A' },
      { runId: 'run2', subscriptionId: 'A' },
    ];
    sessionRenews('run1', 'a2', 'a@x');
    await sync.tick();
    assert.equal(tokenIn(canonical('A')), 'a2', 'the subscription has the new login');
    assert.equal(tokenIn(copyOf('run2')), 'a2', 'and so does the other session, whose refresh token was just spent');
    assert.equal(tokenIn(copyOf('run1')), 'a2');
  });

  it('files a renewal under the account it belongs to, not the file it turned up in', async () => {
    // run1 was being moved from A to B while its claude was renewing A: A's new login lands in a file now meant for B.
    sync.assign('run1', 'B');
    holders = [{ runId: 'run1', subscriptionId: 'B' }];
    sessionRenews('run1', 'a2', 'a@x');
    await sync.tick();
    assert.equal(tokenIn(canonical('A')), 'a2', 'A keeps the login it renewed');
    assert.equal(tokenIn(canonical('B')), 'b1', 'B is not logged in as A');
    assert.equal(tokenIn(copyOf('run1')), 'b1', 'and the session is put back on B');
  });

  it('carries nothing it cannot confirm the owner of, and does not overwrite it either', async () => {
    sync.assign('run1', 'A');
    holders = [{ runId: 'run1', subscriptionId: 'A' }];
    fs.writeFileSync(copyOf('run1'), login('mystery', 8 * HOUR));
    await sync.tick();
    assert.equal(tokenIn(canonical('A')), 'a1', 'the subscription is left alone');
    assert.equal(tokenIn(copyOf('run1')), 'mystery', 'and the newer copy is not replaced by an older login');
  });

  it('never moves a copy backwards to an older login', async () => {
    sync.assign('run1', 'A');
    holders = [{ runId: 'run1', subscriptionId: 'A' }];
    sessionRenews('run1', 'a2', 'a@x');
    writeCredentials(canonical('A'), login('a0', 1 * HOUR));
    // The renewal is confirmed and newer, so it wins over the older canonical login.
    await sync.tick();
    assert.equal(tokenIn(copyOf('run1')), 'a2');
    assert.equal(tokenIn(canonical('A')), 'a2');
  });

  it('after a restart, brings an older copy up to date without taking it for a renewal', async () => {
    sync.assign('run1', 'A');
    fs.writeFileSync(copyOf('run1'), login('a-older', 5 * HOUR));
    accounts.set('a-older', 'a@x');
    holders = [{ runId: 'run1', subscriptionId: 'A' }];
    await make().tick();
    assert.equal(tokenIn(canonical('A')), 'a1', 'the subscription keeps its newer login');
    assert.equal(tokenIn(copyOf('run1')), 'a1', 'and the copy is brought up to it');
  });

  it('after a restart, carries home a renewal a session made while Switchboard was down', async () => {
    sync.assign('run1', 'A');
    sync.assign('run2', 'A');
    fs.writeFileSync(copyOf('run1'), login('a-renewed-meanwhile', 8 * HOUR));
    accounts.set('a-renewed-meanwhile', 'a@x');
    holders = [
      { runId: 'run1', subscriptionId: 'A' },
      { runId: 'run2', subscriptionId: 'A' },
    ];
    await make().tick();
    assert.equal(tokenIn(canonical('A')), 'a-renewed-meanwhile');
    assert.equal(tokenIn(copyOf('run2')), 'a-renewed-meanwhile');
  });

  it('renews a login ahead of its sessions, once at a time', async () => {
    writeCredentials(canonical('A'), login('a1', RENEW_AHEAD_MS - 60_000));
    sync.assign('run1', 'A');
    holders = [{ runId: 'run1', subscriptionId: 'A' }];
    await sync.tick();
    await sync.tick();
    assert.deepEqual(renewed, ['A']);
  });

  it('does not renew a login with plenty of life left, or one nobody holds a copy of', async () => {
    writeCredentials(canonical('B'), login('b1', RENEW_AHEAD_MS - 60_000));
    sync.assign('run1', 'A');
    holders = [{ runId: 'run1', subscriptionId: 'A' }];
    await sync.tick();
    assert.deepEqual(renewed, []);
  });

  it('lets go of a session\'s copy', () => {
    sync.assign('run1', 'A');
    sync.release('run1');
    assert.equal(fs.existsSync(sync.dirFor('run1')), false);
  });

  it('replaces the file whole, leaving nothing half-written or stray behind', () => {
    const file = copyOf('run9');
    writeCredentials(file, login('x', HOUR));
    writeCredentials(file, login('y', HOUR));
    assert.equal(tokenIn(file), 'y');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['.credentials.json']);
  });
});
