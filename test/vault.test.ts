import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Bus } from '../src/daemon/bus.ts';
import { Db } from '../src/daemon/db.ts';
import { gitHelperEnv } from '../src/desk/credential.ts';

describe('which credential covers a repository', async () => {
  const { pickProfile, scopeMatches } = await import('../src/daemon/vault.ts');

  it('matches a host, an owner, or one repository', () => {
    assert.ok(scopeMatches('github.com/contoso/*', 'github.com/contoso/api'));
    assert.ok(scopeMatches('github.com/contoso', 'github.com/contoso/api'));
    assert.ok(scopeMatches('github.com', 'github.com/anyone/anything'));
    assert.ok(scopeMatches('github.com/contoso/api', 'github.com/Contoso/API.git'));
    assert.ok(!scopeMatches('github.com/contoso/*', 'github.com/contosox/api'));
    assert.ok(!scopeMatches('github.com/contoso/api', 'github.com/contoso/api2'));
    assert.ok(scopeMatches('dev.azure.com/fabrikam/*', 'dev.azure.com/fabrikam/core/web'));
  });

  it('prefers the most specific scope', () => {
    const profiles = [{ scope: 'github.com/*', id: 'all' }, { scope: 'github.com/contoso/*', id: 'contoso' }, { scope: 'github.com/contoso/api', id: 'api' }];
    assert.equal(pickProfile(profiles, 'github.com/contoso/api')?.id, 'api');
    assert.equal(pickProfile(profiles, 'github.com/contoso/web')?.id, 'contoso');
    assert.equal(pickProfile(profiles, 'github.com/me/notes')?.id, 'all');
    assert.equal(pickProfile(profiles, 'dev.azure.com/x/y/z'), null);
  });
});

describe('git, pointed at the vault', () => {
  it('puts the helper in front of the vault\'s hosts only, resetting what was there, and asks with the path', () => {
    const env = gitHelperEnv(['github.com'], 'C:\\node\\node.exe', 'C:\\sb\\src\\cli.ts');
    assert.equal(env.GIT_CONFIG_COUNT, '3');
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper');
    assert.equal(env.GIT_CONFIG_VALUE_0, '');
    assert.equal(env.GIT_CONFIG_VALUE_1, '!"C:/node/node.exe" "C:/sb/src/cli.ts" credential');
    assert.equal(env.GIT_CONFIG_KEY_2, 'credential.https://github.com.useHttpPath');
  });
});

describe('the vault', () => {
  let db: Db;
  let server: http.Server;
  let privateKey: string;
  let publicKey: crypto.KeyObject;
  const minted: string[] = [];

  before(async () => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    publicKey = pair.publicKey;
    // A stand-in for api.github.com: checks the App's JWT and mints installation tokens.
    server = http.createServer((req, res) => {
      const jwt = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const [h, p, sig] = jwt.split('.');
      const valid = !!sig && crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
      if (!valid) {
        res.writeHead(401).end('{}');
        return;
      }
      if (req.url?.startsWith('/app/installations?')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ id: 42, account: { login: 'Contoso' } }]));
        return;
      }
      if (req.url === '/app/installations/42/access_tokens' && req.method === 'POST') {
        const token = `ghs_${minted.length}`;
        minted.push(token);
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }));
        return;
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    process.env.SWITCHBOARD_GITHUB_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    db = new Db(':memory:');
  });

  after(() => {
    server.close();
    delete process.env.SWITCHBOARD_GITHUB_API;
  });

  it('hands git a GitHub App installation token for the owner, and reuses it until it nears its end', async () => {
    // Imported after the stand-in's address is set: the module reads it once.
    const { Vault } = await import(`../src/daemon/vault.ts?gh=${Date.now()}`);
    const vault = new Vault(db, new Bus());
    const p = await vault.save({ kind: 'github-app', label: 'App', scope: 'github.com/contoso/*', config: { appId: '1234' }, secret: privateKey });
    assert.equal(p.hasSecret, true);
    assert.equal(JSON.stringify(vault.list()).includes('PRIVATE KEY'), false, 'the secret is never listed');
    const a = await vault.gitCredential('github.com', 'contoso/api.git');
    assert.equal(a?.username, 'x-access-token');
    assert.equal(a?.password, 'ghs_0');
    const b = await vault.gitCredential('github.com', 'contoso/web');
    assert.equal(b?.password, 'ghs_0', 'one installation, one token, while it lasts');
    assert.equal(await vault.gitCredential('github.com', 'someoneelse/x'), null);
    const snap = await vault.refreshSnapshot();
    assert.deepEqual(snap.hosts, ['github.com']);
    assert.equal(snap.shims, true);
  });

  it('refuses what is not a usable credential', async () => {
    const { Vault } = await import('../src/daemon/vault.ts');
    const vault = new Vault(db, new Bus());
    await assert.rejects(vault.save({ kind: 'github-app', label: 'x', scope: 'github.com/*', config: { appId: '1' }, secret: 'not a key' }), /private key/);
    await assert.rejects(vault.save({ kind: 'azure-sp', label: 'x', scope: 'azure', config: { tenantId: 't' }, secret: 's' }), /clientId/);
    await assert.rejects(vault.save({ kind: 'nope', scope: 'github.com' }), /kind must be/);
  });

  it('gives an Azure DevOps PAT to git for its organisation, and to the Azure SDKs and devops extension', async () => {
    const { Vault } = await import('../src/daemon/vault.ts');
    const vault = new Vault(db, new Bus());
    await vault.save({ kind: 'ado-pat', label: 'ADO', scope: 'dev.azure.com/fabrikam/*', secret: 'pat-123' });
    await vault.save({ kind: 'azure-sp', label: 'SP', scope: 'azure', config: { tenantId: 'tid', clientId: 'cid', subscriptionId: 'sub' }, secret: 'sp-secret' });
    const git = await vault.gitCredential('dev.azure.com', 'fabrikam/core/_git/web');
    assert.equal(git?.password, 'pat-123');
    const env = await vault.sessionEnv();
    assert.deepEqual(env, { AZURE_TENANT_ID: 'tid', AZURE_CLIENT_ID: 'cid', AZURE_CLIENT_SECRET: 'sp-secret', AZURE_SUBSCRIPTION_ID: 'sub', AZURE_DEVOPS_EXT_PAT: 'pat-123' });
    const az = await vault.toolCredential('az', null);
    assert.equal(az.azureLogin?.clientId, 'cid');
    assert.equal(az.env.AZURE_DEVOPS_EXT_PAT, 'pat-123');
  });
});
