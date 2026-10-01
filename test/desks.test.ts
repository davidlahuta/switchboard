import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Bus } from '../src/daemon/bus.ts';
import { Coordinator } from '../src/daemon/coord.ts';
import { Db } from '../src/daemon/db.ts';
import { DeskManager } from '../src/daemon/desks.ts';
import { defaultMaxSessions, deskPlacement, LOCAL_DESK, type PlacementDesk, remoteKey } from '../src/shared/desk.ts';

describe('a repository across desks', () => {
  it('is its origin, however that is written', () => {
    const forms = [
      'https://github.com/Contoso/Api.git',
      'https://github.com/contoso/api',
      'git@github.com:contoso/api.git',
      'ssh://git@github.com/contoso/api.git',
      'https://someone:token@github.com/contoso/api.git/',
    ];
    for (const f of forms) assert.equal(remoteKey(f), 'github.com/contoso/api', f);
  });

  it('folds the two Azure DevOps spellings into one', () => {
    assert.equal(remoteKey('https://dev.azure.com/fabrikam/core/_git/web'), 'dev.azure.com/fabrikam/core/web');
    assert.equal(remoteKey('https://fabrikam@dev.azure.com/fabrikam/core/_git/web'), 'dev.azure.com/fabrikam/core/web');
    assert.equal(remoteKey('https://fabrikam.visualstudio.com/core/_git/web'), 'dev.azure.com/fabrikam/core/web');
    assert.equal(remoteKey('https://fabrikam.visualstudio.com/DefaultCollection/core/_git/web'), 'dev.azure.com/fabrikam/core/web');
    assert.equal(remoteKey('git@ssh.dev.azure.com:v3/fabrikam/core/web'), 'dev.azure.com/fabrikam/core/web');
  });

  it('is nothing without an origin', () => {
    assert.equal(remoteKey(null), null);
    assert.equal(remoteKey(''), null);
  });
});

describe('where a new session goes', () => {
  const desk = (id: string, over: Partial<PlacementDesk> = {}): PlacementDesk => ({
    id,
    online: true,
    enabled: true,
    allowed: true,
    hasRepo: true,
    load: 0,
    max: 4,
    repoSessions: 0,
    hub: id === LOCAL_DESK,
    ...over,
  });

  it('prefers a desk with room that already has the repository', () => {
    const r = deskPlacement([desk(LOCAL_DESK, { load: 1, hasRepo: false }), desk('b', { load: 3 })]);
    assert.deepEqual(r, { ok: true, desk: 'b', overflow: false, clone: false });
  });

  it('among desks with the repository and room, takes the least loaded for its size', () => {
    const r = deskPlacement([desk(LOCAL_DESK, { load: 3, max: 6 }), desk('b', { load: 1, max: 4 })]);
    assert.equal(r.ok && r.desk, 'b');
  });

  it('clones onto a desk with room rather than overflow a desk that has the repository', () => {
    const r = deskPlacement([desk(LOCAL_DESK, { load: 4, max: 4 }), desk('b', { load: 0, hasRepo: false })]);
    assert.deepEqual(r, { ok: true, desk: 'b', overflow: false, clone: true });
  });

  it('goes over a maximum only when every eligible desk is at its own', () => {
    const r = deskPlacement([desk(LOCAL_DESK, { load: 6, max: 4 }), desk('b', { load: 4, max: 4 })]);
    assert.deepEqual(r, { ok: true, desk: 'b', overflow: true, clone: false });
  });

  it('never counts a desk that cannot take it: offline, disabled, not allowed', () => {
    const r = deskPlacement([desk(LOCAL_DESK, { load: 9, max: 4 }), desk('b', { online: false }), desk('c', { enabled: false }), desk('d', { allowed: false })]);
    assert.deepEqual(r, { ok: true, desk: LOCAL_DESK, overflow: true, clone: false });
  });

  it('says why nowhere would do', () => {
    const r = deskPlacement([desk(LOCAL_DESK, { allowed: false }), desk('b', { online: false })]);
    assert.equal(r.ok, false);
    assert.deepEqual(!r.ok && r.reasons.map((x) => x.why), ['not allowed for this repository', 'offline']);
  });

  it('takes the desk it is pinned to, whatever the others look like', () => {
    const r = deskPlacement([desk(LOCAL_DESK), desk('b', { load: 9, max: 4 })], { pinned: 'b', canClone: true });
    assert.deepEqual(r, { ok: true, desk: 'b', overflow: true, clone: false });
  });

  it('keeps a repository on the desk already running it, all else equal', () => {
    const r = deskPlacement([desk(LOCAL_DESK, { load: 2 }), desk('b', { load: 2, repoSessions: 2 })]);
    assert.equal(r.ok && r.desk, 'b');
  });

  it('a desk with a maximum of nought only takes overflow', () => {
    const r = deskPlacement([desk(LOCAL_DESK, { max: 0 }), desk('b', { load: 1, max: 2 })]);
    assert.equal(r.ok && r.desk, 'b');
  });

  it('guesses a maximum from the hardware it is told about', () => {
    assert.equal(defaultMaxSessions(16, 64), 8);
    assert.equal(defaultMaxSessions(4, 64), 2);
    assert.equal(defaultMaxSessions(32, 16), 4);
    assert.equal(defaultMaxSessions(null, null), 4);
  });
});

describe('desk registry', () => {
  let db: Db;
  let desks: DeskManager;

  before(() => {
    db = new Db(':memory:');
    desks = new DeskManager(db, new Bus(), {
      liveRuns: () => 0,
      runsOn: () => [],
      loginFile: () => null,
      seed: () => ({ files: {}, claudeJson: {} }),
      localTools: () => null,
      localRepoRoots: () => [],
      scanLocal: async () => [],
    });
  });

  it('always has the hub, which cannot be removed', () => {
    assert.equal(desks.list()[0].id, LOCAL_DESK);
    assert.equal(desks.list()[0].hub, true);
    assert.throws(() => desks.remove(LOCAL_DESK));
  });

  it('pairs a desk once per code, and knows it by its token after', () => {
    const { code } = desks.createPairing('https://hub.example.ts.net');
    const joined = desks.join(code, { hostname: 'BOX-2', name: 'Second desk' });
    assert.equal(desks.deskOfToken(`Bearer ${joined.token}`), joined.deskId);
    assert.equal(desks.deskOfToken('Bearer nonsense'), null);
    assert.throws(() => desks.join(code, { hostname: 'BOX-3' }), /Invalid or expired/);
    assert.equal(desks.get(joined.deskId)?.name, 'Second desk');
    assert.equal(desks.online(joined.deskId), false);
    desks.remove(joined.deskId);
    assert.equal(desks.deskOfToken(`Bearer ${joined.token}`), null);
  });

  it('keeps a desk\'s mirror inside its own folder, whatever path the desk sends', () => {
    const base = desks.mirrorBase('ab12');
    assert.equal(desks.mirrorPath('ab12', 'home', 'projects/x/s.jsonl'), path.join(base, 'home', 'projects', 'x', 's.jsonl'));
    assert.equal(desks.mirrorPath('ab12', 'profile/max-1', 'sessions/12.json'), path.join(base, 'profile', 'max-1', 'sessions', '12.json'));
    assert.equal(desks.mirrorPath('ab12', 'home', '../../../etc/passwd'), null);
    assert.equal(desks.mirrorPath('ab12', 'profile/../x' as 'home', 'a'), null);
    assert.equal(desks.mirrorPath('../x', 'home', 'a'), null);
    assert.equal(desks.fromDeskPath('ab12', 'desk://home/projects/x/s.jsonl'), path.join(base, 'home', 'projects', 'x', 's.jsonl'));
    assert.equal(desks.fromDeskPath('ab12', 'C:\\Users\\x\\a.jsonl'), 'C:\\Users\\x\\a.jsonl');
  });

  it('remembers what a desk has cloned, by repository', () => {
    desks.setRepos(LOCAL_DESK, [{ path: 'C:\\src\\api', remoteKey: 'github.com/contoso/api', remoteUrl: 'https://github.com/contoso/api', name: 'api', branch: 'main' }]);
    assert.equal(desks.repoPath(LOCAL_DESK, 'github.com/contoso/api'), 'C:\\src\\api');
    assert.equal(desks.repoPath(LOCAL_DESK, 'github.com/contoso/web'), null);
  });

  it('takes the operator\'s maximum over the guess, and goes back to the guess when cleared', () => {
    desks.update(LOCAL_DESK, { recommendedMaxSessions: 7 });
    assert.equal(desks.maxSessions(LOCAL_DESK), 7);
    assert.equal(desks.get(LOCAL_DESK)?.maxIsDefault, false);
    desks.update(LOCAL_DESK, { recommendedMaxSessions: null });
    assert.equal(desks.get(LOCAL_DESK)?.maxIsDefault, true);
  });
});

describe('one board for a repository on two desks', () => {
  let dir: string;
  let db: Db;
  let coord: Coordinator;

  before(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-desk-')));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/contoso/api.git'], { cwd: dir, stdio: 'ignore' });
    db = new Db(':memory:');
    coord = new Coordinator(db, new Bus());
    // The satellite is somebody else's machine: its answer about its own folder is all there is.
    coord.setRepoResolver(async (d) => ({ root: 'D:\\code\\api', worktree: 'D:\\code\\api', branch: 'main', isGit: true, remoteKey: d.startsWith('D:\\code\\api') ? 'github.com/contoso/api' : null }));
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('files a satellite agent in a clone of the same remote on the hub\'s board', async () => {
    const hubAgent = await coord.registerAgent({ sessionId: 'hub-session', cwd: dir });
    const remote = await coord.registerAgent({ sessionId: 'desk-session', cwd: 'D:\\code\\api', deskId: 'ab12' });
    assert.equal(remote.repo_id, hubAgent.repo_id);
    assert.equal(remote.desk_id, 'ab12');
    assert.equal(hubAgent.desk_id, null);
  });

  it('gives a repository nobody else has a board of its own, keyed by the desk', async () => {
    coord.setRepoResolver(async () => ({ root: 'D:\\code\\solo', worktree: 'D:\\code\\solo', branch: null, isGit: true, remoteKey: 'github.com/contoso/solo' }));
    const a = await coord.registerAgent({ sessionId: 'solo-session', cwd: 'D:\\code\\solo', deskId: 'ab12' });
    const hubAgent = coord.agent('hub-session')!;
    assert.notEqual(a.repo_id, hubAgent.repo_id);
  });

  it('never judges a satellite\'s repository by what is on this disk', () => {
    const rows = db.all<{ desk_id: string | null }>('SELECT desk_id FROM repos');
    assert.ok(rows.some((r) => r.desk_id === 'ab12'));
    coord.prune();
    assert.ok(db.all<{ desk_id: string | null }>('SELECT desk_id FROM repos').some((r) => r.desk_id === 'ab12'));
  });
});
