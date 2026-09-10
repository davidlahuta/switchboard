import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Bus } from '../src/daemon/bus.ts';
import { Coordinator, findWaitCycle, type PushTarget } from '../src/daemon/coord.ts';
import { Db } from '../src/daemon/db.ts';
import { matchesPattern, patternsOverlap, relPath } from '../src/git.ts';
import { UNREAD_CAP } from '../src/shared/types.ts';

describe('path matching', () => {
  it('matches exact files, directories and globs', async () => {
    assert.ok(matchesPattern('src/a.ts', 'src/a.ts'));
    assert.ok(matchesPattern('src/auth/login.ts', 'src/auth'));
    assert.ok(matchesPattern('src/auth/login.ts', 'src/auth/'));
    assert.ok(matchesPattern('src/auth/deep/x.ts', 'src/auth/**'));
    assert.ok(matchesPattern('src/a.ts', './src/*.ts'));
    assert.ok(!matchesPattern('src/a/b.ts', 'src/*.ts'));
    assert.ok(!matchesPattern('src/authz.ts', 'src/auth'));
  });

  it('detects overlapping patterns', async () => {
    assert.ok(patternsOverlap('src/auth/**', 'src/auth/login.ts'));
    assert.ok(patternsOverlap('src', 'src/auth/**'));
    assert.ok(!patternsOverlap('src/auth/**', 'docs/**'));
  });

  it('computes repo-relative paths', async () => {
    const root = path.resolve(os.tmpdir(), 'repo');
    assert.equal(relPath(root, path.join(root, 'src', 'a.ts')), 'src/a.ts');
    assert.equal(relPath(root, path.resolve(root, '..', 'other', 'a.ts')), null);
  });
});

describe('coordinator', () => {
  let dir: string;
  let db: Db;
  let coord: Coordinator;
  const pushed: Array<{ agentId: string; content: string; meta: Record<string, string> }> = [];
  const channelAgents = new Set<string>();

  before(async () => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-')));
    // A real repository, because that is what the agents in it are: a session only moves between
    // boards when it moves between repositories, so a bare directory cannot stand in for one.
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    db = new Db(':memory:');
    coord = new Coordinator(db, new Bus());
    const target: PushTarget = {
      push: (agentId, content, meta) => {
        if (!channelAgents.has(agentId)) return false;
        pushed.push({ agentId, content, meta });
        return true;
      },
      isConnected: (id) => channelAgents.has(id),
      rekey: (oldId, newId) => {
        if (!channelAgents.delete(oldId)) return false;
        channelAgents.add(newId);
        return true;
      },
    };
    coord.setPushTarget(target);
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('groups agents by repo and names them uniquely', async () => {
    const a = await coord.registerAgent({ sessionId: 'aaaa1111', cwd: dir, name: 'alpha' });
    const b = await coord.registerAgent({ sessionId: 'bbbb2222', cwd: dir, name: 'alpha', hasChannel: true });
    channelAgents.add(b.id);
    assert.equal(a.repo_id, b.repo_id);
    assert.equal(a.name, 'alpha');
    assert.equal(b.name, 'alpha-2');
  });

  it('pushes questions immediately and defers info broadcasts to hooks', async () => {
    const repoId = coord.agent('aaaa1111')!.repo_id;
    coord.send('aaaa1111', repoId, 'alpha-2', 'question', 'Are you touching src/db.ts?');
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].meta.kind, 'question');

    coord.send('aaaa1111', repoId, 'all', 'info', 'FYI: renamed Foo to Bar');
    assert.equal(pushed.length, 1, 'info broadcast must not wake the other agent');
    const pb = coord.piggyback('bbbb2222');
    assert.match(pb ?? '', /renamed Foo to Bar/);
    assert.equal(coord.piggyback('bbbb2222'), null, 'each message is delivered once');
  });

  it('warns on overlapping edits and notifies the other agent', async () => {
    const file = path.join(dir, 'src', 'shared.ts');
    assert.equal(await coord.recordEdit('aaaa1111', file, 'Edit'), null);
    const warning = await coord.recordEdit('bbbb2222', file, 'Edit');
    assert.match(warning ?? '', /src\/shared\.ts/);
    assert.match(warning ?? '', /alpha/);
    const detail = coord.repoDetail(coord.agent('aaaa1111')!.repo_id)!;
    assert.equal(detail.conflicts.filter((c) => c.status === 'open').length, 1);
    // alpha has no channel: the conflict notice waits for its next hook
    assert.match(coord.piggyback('aaaa1111') ?? '', /just edited src\/shared\.ts/);
  });

  it('blocks edits inside another agent’s exclusive claim', async () => {
    coord.claim('aaaa1111', ['src/billing/**'], true, 'migrating billing', 30);
    const verdict = await coord.preEdit('bbbb2222', path.join(dir, 'src', 'billing', 'invoice.ts'));
    assert.match(verdict.deny ?? '', /exclusively claimed/);
    assert.equal((await coord.preEdit('aaaa1111', path.join(dir, 'src', 'billing', 'invoice.ts'))).deny, undefined);
    coord.release('aaaa1111');
    assert.equal((await coord.preEdit('bbbb2222', path.join(dir, 'src', 'billing', 'invoice.ts'))).deny, undefined);
  });

  it('resolves await_reply when a reply arrives', async () => {
    const repoId = coord.agent('aaaa1111')!.repo_id;
    const pending = coord.runTool('aaaa1111', 'sb_send', { to: 'alpha-2', body: 'ok to merge?', kind: 'question', await_reply_seconds: 5 });
    await new Promise((r) => setTimeout(r, 20));
    const asked = coord.repoDetail(repoId)!.messages.at(-1)!;
    coord.send('bbbb2222', repoId, 'alpha', 'info', 'yes, go ahead', false, asked.id);
    const result = await pending;
    assert.match(result.text, /yes, go ahead/);
  });

  it('identifies sessions by GUID, treating names as reusable aliases', async () => {
    const repoId = coord.agent('aaaa1111')!.repo_id;
    // The session id always wins, even when a display name would be ambiguous.
    assert.equal(coord.findAgent(repoId, 'aaaa1111')?.id, 'aaaa1111');
    assert.equal(coord.findAgent(repoId, 'bbbb2222')?.id, 'bbbb2222');

    // A name freed by an offline session can be taken by a new one; the old GUID still resolves.
    const original = coord.agent('aaaa1111')!;
    coord.markOffline('aaaa1111', 'test');
    const reuser = await coord.registerAgent({ sessionId: 'cccc3333', cwd: dir, name: original.name });
    assert.equal(reuser.name, original.name, 'name is reusable once the holder is offline');
    assert.equal(coord.findAgent(repoId, original.name)?.id, 'cccc3333', 'the live agent wins the alias');
    assert.equal(coord.findAgent(repoId, 'aaaa1111')?.id, 'aaaa1111', 'the GUID still resolves the old session');

    // An ambiguous name is refused rather than guessed.
    await coord.registerAgent({ sessionId: 'aaaa1111', cwd: dir });
    coord.raw.run('UPDATE agents SET name = ? WHERE id = ?', original.name, 'aaaa1111');
    assert.throws(() => coord.findAgent(repoId, original.name), /matches 2 live agents/);

    coord.raw.run('UPDATE agents SET name = ? WHERE id = ?', 'alpha', 'aaaa1111');
    coord.markOffline('cccc3333', 'test');
  });

  it('leaves an agent where it is when it steps outside version control', async () => {
    // A command run in a temp directory, or a look under ~/.claude: not a change of project. Taking
    // it for one put a board on the nav for every such directory and took the session's intent and
    // claims off the repository it was actually working in.
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-scratch-')));
    try {
      const before = coord.agent('aaaa1111')!;
      coord.setIntent('aaaa1111', 'still working here', ['src/**']);
      await coord.setCwd('aaaa1111', scratch);
      const after = coord.agent('aaaa1111')!;
      assert.equal(after.repo_id, before.repo_id);
      assert.equal(after.intent, 'still working here', 'and it keeps what it announced');
      assert.equal(after.cwd, scratch, 'though where it is is still recorded');
      assert.ok(!coord.listRepos().some((r) => r.root === scratch), 'no board for a directory that is not a repository');
      coord.release('aaaa1111');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('re-groups an agent that moves to another repo', async () => {
    const other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-other-')));
    execFileSync('git', ['init'], { cwd: other, stdio: 'ignore' });
    try {
      const before = coord.agent('aaaa1111')!;
      coord.claim('aaaa1111', ['src/**'], false, null, 30);
      coord.setIntent('aaaa1111', 'work in the first repo', []);
      await coord.setCwd('aaaa1111', other);
      const after = coord.agent('aaaa1111')!;
      assert.notEqual(after.repo_id, before.repo_id, 'agent must join the new repo group');
      assert.equal(after.intent, null, 'intent belonged to the old repo');
      assert.equal(coord.repoDetail(before.repo_id)!.claims.filter((c) => c.agentId === 'aaaa1111').length, 0);
      // and it is gone from the old repo's roster
      assert.ok(!coord.repoDetail(before.repo_id)!.agents.some((x) => x.id === 'aaaa1111'));
      await coord.setCwd('aaaa1111', dir); // move back for the remaining tests
      assert.equal(coord.agent('aaaa1111')!.repo_id, before.repo_id);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps a non-channel agent working when someone waits on it', async () => {
    const repoId = coord.agent('aaaa1111')!.repo_id;
    coord.piggyback('aaaa1111');
    coord.send('bbbb2222', repoId, 'alpha', 'request', 'please rebase on main');
    assert.match(coord.stopBlockReason('aaaa1111') ?? '', /please rebase on main/);
    assert.equal(coord.stopBlockReason('aaaa1111'), null);
  });

  it('counts unread from the watermark and stops at the cap', async () => {
    const repoId = coord.agent('aaaa1111')!.repo_id;
    const unreadFor = (id: string): number => coord.repoDetail(repoId)!.agents.find((a) => a.id === id)!.unread;
    const mark = (id: string): number => coord.raw.get<{ n: number }>('SELECT read_through_id AS n FROM agents WHERE id = ?', id)!.n;

    coord.piggyback('aaaa1111');
    const settled = mark('aaaa1111');
    assert.ok(settled > 0, 'an agent with nothing waiting is watermarked at the head');

    coord.send('bbbb2222', repoId, 'alpha', 'info', 'one for you');
    assert.equal(unreadFor('aaaa1111'), 1);
    assert.equal(mark('aaaa1111'), settled, 'the watermark cannot pass an unread message');
    coord.piggyback('aaaa1111');
    assert.equal(unreadFor('aaaa1111'), 0);
    assert.ok(mark('aaaa1111') > settled, 'delivering it moves the watermark on');

    for (let i = 0; i < UNREAD_CAP + 25; i++) coord.send('bbbb2222', repoId, 'alpha', 'info', `bulk ${i}`);
    assert.equal(unreadFor('aaaa1111'), UNREAD_CAP, 'counting stops at the cap rather than walking the backlog');
  });

  it('renames an agent when its session is renamed', async () => {
    coord.renameAgent('aaaa1111', 'billing work');
    assert.equal(coord.agent('aaaa1111')!.name, 'billing-work');
    coord.renameAgent('aaaa1111', 'alpha');
  });
});

describe('pushing agents to use the board', () => {
  let dir: string;
  let db: Db;
  let coord: Coordinator;
  let repoId: string;
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-nudge-'));
    db = new Db(':memory:');
    coord = new Coordinator(db, new Bus());
    coord.setPushTarget({ push: () => false, isConnected: () => false, rekey: () => false });
    repoId = (await coord.registerAgent({ sessionId: 'n1111111', cwd: dir, name: 'ann' })).repo_id;
    await coord.registerAgent({ sessionId: 'n2222222', cwd: dir, name: 'bob' });
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks an agent that has been editing without announcing anything', async () => {
    const file = path.join(dir, 'src', 'quiet.ts');
    assert.equal((await coord.preEdit('n1111111', file)).context, undefined, 'a session that just started is left alone');

    coord.raw.run('UPDATE agents SET started_at = ? WHERE id = ?', ago(20 * 60_000), 'n1111111');
    assert.match((await coord.preEdit('n1111111', file)).context ?? '', /sb_intent/);
    assert.equal((await coord.preEdit('n1111111', file)).context, undefined, 'said once, not on every edit');
  });

  it('says nothing to an agent that has announced its task', async () => {
    coord.raw.run('UPDATE agents SET started_at = ? WHERE id = ?', ago(20 * 60_000), 'n2222222');
    coord.setIntent('n2222222', 'rewriting the parser', ['src/parse/**']);
    assert.equal((await coord.preEdit('n2222222', path.join(dir, 'src', 'parse', 'lex.ts'))).context, undefined);
  });

  it('broadcasts an intent to the agents already running', async () => {
    assert.match(coord.piggyback('n1111111') ?? '', /rewriting the parser/);
  });

  it('asks the holder of a claim it has stopped using to release it', async () => {
    coord.claim('n2222222', ['src/parse/**'], true, 'parser rewrite', 120);
    coord.sweep();
    assert.equal(coord.piggyback('n2222222'), null, 'a fresh claim is not worth mentioning');

    coord.raw.run('UPDATE claims SET created_at = ? WHERE agent_id = ?', ago(60 * 60_000), 'n2222222');
    coord.sweep();
    const nudge = coord.piggyback('n2222222') ?? '';
    assert.match(nudge, /sb_release/);
    assert.match(nudge, /src\/parse/);
    coord.sweep();
    assert.equal(coord.piggyback('n2222222'), null, 'the reminder does not repeat every minute');
    coord.release('n2222222');
  });

  it('tells the agent that owes an answer, and the asker once it is gone', async () => {
    const asked = coord.send('n1111111', repoId, 'bob', 'question', 'can I touch src/parse/lex.ts?');
    coord.piggyback('n2222222');
    coord.raw.run('UPDATE messages SET created_at = ? WHERE id = ?', ago(30 * 60_000), asked.id);

    coord.sweep();
    assert.match(coord.piggyback('n2222222') ?? '', new RegExp(`not answered #${asked.id}`));

    // Gone without replying: the one left waiting is the one who needs to hear about it.
    coord.markOffline('n2222222', 'test');
    coord.raw.run('UPDATE messages SET created_at = ? WHERE id = ?', ago(30 * 60_000), asked.id);
    coord.sweep();
    assert.equal(coord.piggyback('n1111111'), null, 'still inside the reminder window');

    const second = coord.send('n1111111', repoId, 'bob', 'question', 'and src/parse/ast.ts?');
    coord.raw.run(
      'INSERT INTO deliveries (message_id, agent_id, via, delivered_at) VALUES (?, ?, ?, ?)',
      second.id,
      'n2222222',
      'test',
      new Date().toISOString(),
    );
    coord.raw.run('UPDATE messages SET created_at = ? WHERE id = ?', ago(30 * 60_000), second.id);
    coord.sweep();
    assert.match(coord.piggyback('n1111111') ?? '', /went offline without answering/);
  });

  it('believes a hook over a process id that outlived its process', async () => {
    // The shape this takes in life: the session was swapped or the daemon restarted, so the pid on
    // record belongs to a process several lifetimes back, while the session itself is mid-turn.
    const dead = 0x7ffffffe; // nothing is running here
    coord.raw.run('UPDATE agents SET pid = ?, status = ?, last_seen = ? WHERE id = ?', dead, 'working', new Date().toISOString(), 'n1111111');

    coord.sweep();
    assert.equal(coord.agent('n1111111')!.status, 'working', 'a session heard from seconds ago is not dead');
    assert.equal(coord.agent('n1111111')!.pid, null, 'and the pid that said otherwise is dropped as stale');

    // A pid that fails while the session has also gone quiet is taken at its word.
    await coord.registerAgent({ sessionId: 'n3333333', cwd: dir, name: 'cal', pid: dead });
    coord.raw.run('UPDATE agents SET last_seen = ? WHERE id = ?', new Date(Date.now() - 10 * 60_000).toISOString(), 'n3333333');
    coord.sweep();
    assert.equal(coord.agent('n3333333')!.status, 'offline');
  });

  it('ends sb_status on what this agent owes the others', async () => {
    const status = coord.statusText('n1111111');
    assert.match(status, /Owed by you/);
    assert.match(status, /sb_intent/, 'it never announced a task');
  });
});

describe('waiting on another agent', () => {
  it('tells a queue from a ring', () => {
    // Three agents all waiting on one: it clears the moment that one finishes.
    assert.equal(findWaitCycle([{ waiter: 'a', holder: 'd' }, { waiter: 'b', holder: 'd' }, { waiter: 'c', holder: 'd' }]), null);
    // A chain is still a queue, however long.
    assert.equal(findWaitCycle([{ waiter: 'a', holder: 'b' }, { waiter: 'b', holder: 'c' }]), null);

    const pair = findWaitCycle([{ waiter: 'a', holder: 'b' }, { waiter: 'b', holder: 'a' }]);
    assert.deepEqual([...(pair ?? [])].sort(), ['a', 'b']);

    const ring = findWaitCycle([
      { waiter: 'a', holder: 'b' },
      { waiter: 'b', holder: 'c' },
      { waiter: 'c', holder: 'a' },
      { waiter: 'z', holder: 'a' },
    ]);
    assert.deepEqual([...(ring ?? [])].sort(), ['a', 'b', 'c'], 'the ring, not the agent queued behind it');
  });

  it('ignores an agent listed as waiting on itself', () => {
    assert.equal(findWaitCycle([{ waiter: 'a', holder: 'a' }]), null);
  });
});

describe('a board that keeps itself honest', () => {
  let dir: string;
  let db: Db;
  let coord: Coordinator;
  let repoId: string;
  const ended = new Set<string>();
  const back = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const file = (...parts: string[]): string => path.join(dir, ...parts);
  const backdateBlocks = (ms: number): void => {
    coord.raw.run('UPDATE blocks SET since = ?', back(ms));
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-honest-'));
    db = new Db(':memory:');
    coord = new Coordinator(db, new Bus());
    coord.setPushTarget({ push: () => false, isConnected: () => false, rekey: () => false });
    coord.setSessionGone((id) => ended.has(id));
    repoId = (await coord.registerAgent({ sessionId: 'h1111111', cwd: dir, name: 'hilda' })).repo_id;
    await coord.registerAgent({ sessionId: 'h2222222', cwd: dir, name: 'igor' });
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records who is waiting on a claim, and shows it to the operator', async () => {
    coord.claim('h1111111', ['src/api/**'], true, 'rewriting the client', 240);
    assert.match((await coord.preEdit('h2222222', file('src', 'api', 'client.ts'))).deny ?? '', /exclusively claimed/);

    const claim = coord.repoDetail(repoId)!.claims.find((c) => c.pattern === 'src/api/**')!;
    assert.equal(claim.waiting.length, 1, 'the wait is on the board, not only inside the blocked agent');
    assert.equal(claim.waiting[0].agentName, 'igor');
    assert.equal(claim.waiting[0].path, 'src/api/client.ts');
  });

  it('leaves a claim alone while its holder is still working in it', async () => {
    await coord.recordEdit('h1111111', file('src', 'api', 'server.ts'), 'Edit');
    backdateBlocks(30 * 60_000);
    coord.sweep();

    assert.ok((await coord.preEdit('h2222222', file('src', 'api', 'client.ts'))).deny, 'still held');
    assert.match(coord.piggyback('h1111111') ?? '', /blocked on your exclusive claim/, 'but the holder is told somebody is there');
  });

  it('breaks a claim its holder has stopped using rather than leaving anyone stuck', async () => {
    backdateBlocks(30 * 60_000);
    // Nothing touched inside the claim since the wait began.
    coord.raw.run('UPDATE file_touches SET ts = ? WHERE agent_id = ?', back(60 * 60_000), 'h1111111');
    coord.sweep();

    assert.equal((await coord.preEdit('h2222222', file('src', 'api', 'client.ts'))).deny, undefined, 'the wait is over');
    assert.match(coord.piggyback('h1111111') ?? '', /was released/, 'the holder hears it from Switchboard rather than from a silence');
    assert.match(coord.piggyback('h2222222') ?? '', /is free/, 'and so does whoever was waiting');
    assert.ok(
      coord.repoDetail(repoId)!.events.some((e) => /Switchboard released .*src\/api/.test(e.summary)),
      'the operator can see it happened',
    );
  });

  it('breaks a ring of agents waiting on each other', async () => {
    coord.release('h1111111');
    coord.release('h2222222');
    coord.claim('h1111111', ['src/left/**'], true, 'left half', 240);
    coord.claim('h2222222', ['src/right/**'], true, 'right half', 240);
    // Each wants what the other holds, and each is busy with its own half, so nothing frees itself.
    await coord.preEdit('h1111111', file('src', 'right', 'a.ts'));
    await coord.preEdit('h2222222', file('src', 'left', 'b.ts'));
    await coord.recordEdit('h1111111', file('src', 'left', 'own.ts'), 'Edit');
    await coord.recordEdit('h2222222', file('src', 'right', 'own.ts'), 'Edit');

    backdateBlocks(3 * 60_000);
    coord.sweep();

    const detail = coord.repoDetail(repoId)!;
    assert.equal(detail.claims.filter((c) => c.exclusive).length, 1, 'one side of the ring is released — the least that unsticks it');
    const conflict = detail.conflicts.find((c) => c.kind === 'deadlock');
    assert.ok(conflict, 'and the operator is shown a deadlock rather than another overlap');
    assert.match(conflict!.detail ?? '', /hilda|igor/);
    assert.match(coord.piggyback('h1111111') ?? '', /Deadlock/);
  });

  it('warns before a second agent writes a file the first one just wrote', async () => {
    coord.release('h1111111');
    coord.release('h2222222');
    await coord.recordEdit('h1111111', file('src', 'shared', 'both.ts'), 'Edit');
    const verdict = await coord.preEdit('h2222222', file('src', 'shared', 'both.ts'));
    assert.equal(verdict.deny, undefined, 'nobody claimed it, so nothing is refused');
    assert.match(verdict.context ?? '', /edited just now by hilda/);
    assert.equal((await coord.preEdit('h2222222', file('src', 'shared', 'both.ts'))).context, undefined, 'said once, not on every edit');
  });

  it('holds a turn open for a question the agent has read and not answered', () => {
    const asked = coord.send('h1111111', repoId, 'igor', 'question', 'are you rewriting the client or am I?');
    coord.raw.run('INSERT INTO deliveries (message_id, agent_id, via, delivered_at) VALUES (?, ?, ?, ?)', asked.id, 'h2222222', 'test', back(60_000));

    const reason = coord.stopBlockReason('h2222222') ?? '';
    assert.match(reason, /have not answered/);
    assert.match(reason, new RegExp(`reply_to=${asked.id}`), 'and it is told exactly how');
    assert.equal(coord.stopBlockReason('h2222222'), null, 'asked once: an agent that stops anyway has decided');

    coord.send('h2222222', repoId, 'hilda', 'info', 'you are, I am on the server', false, asked.id);
    assert.equal(coord.stopBlockReason('h2222222'), null);
  });

  it('holds a turn open for a lock somebody is standing in front of', async () => {
    coord.claim('h1111111', ['src/db/**'], true, 'schema change', 240);
    await coord.preEdit('h2222222', file('src', 'db', 'schema.ts'));

    const reason = coord.stopBlockReason('h1111111') ?? '';
    assert.match(reason, /igor wants src\/db\/schema\.ts/);
    assert.match(reason, /sb_release/);
    coord.release('h1111111');
    assert.equal(coord.stopBlockReason('h1111111'), null, 'nothing owed once the lock is gone');
  });

  it('says nothing to an agent that owes nothing', () => {
    assert.equal(coord.stopBlockReason('h2222222'), null);
  });

  it('takes a session off the board when its tools disconnect for good', async () => {
    await coord.registerAgent({ sessionId: 'h3333333', cwd: dir, name: 'jo' });
    coord.claim('h3333333', ['src/gone/**'], true, 'work in progress', 240);
    coord.shimClosed('h3333333', Date.now() - 5 * 60_000);

    coord.raw.run('UPDATE agents SET last_seen = ? WHERE id = ?', back(5 * 60_000), 'h3333333');
    coord.sweep();

    assert.equal(coord.agent('h3333333')!.status, 'offline');
    assert.equal((await coord.preEdit('h1111111', file('src', 'gone', 'x.ts'))).deny, undefined, 'a dead agent holds nothing');
  });

  it('believes a hook over a shim that dropped', () => {
    coord.raw.run("INSERT INTO agents (id, repo_id, name, status, has_channel, started_at, last_seen, read_through_id) VALUES ('h4444444', ?, 'kit', 'working', 0, ?, ?, 0)", repoId, back(60 * 60_000), back(60 * 60_000));
    coord.shimClosed('h4444444');
    coord.setStatus('h4444444', 'working');
    coord.sweep();
    assert.equal(coord.agent('h4444444')!.status, 'working', 'the session is plainly alive; only its MCP server went');
  });

  it('takes a session off the board the moment its run is over', async () => {
    await coord.registerAgent({ sessionId: 'h5555555', cwd: dir, name: 'lou' });
    coord.raw.run('UPDATE agents SET last_seen = ? WHERE id = ?', back(5 * 60_000), 'h5555555');
    coord.sweep();
    assert.notEqual(coord.agent('h5555555')!.status, 'offline', 'silence alone means nothing: an idle session makes plenty of it');

    ended.add('h5555555');
    coord.sweep();
    assert.equal(coord.agent('h5555555')!.status, 'offline');
  });
});

describe('a session that clears its conversation', () => {
  let dir: string;
  let db: Db;
  let coord: Coordinator;
  let repoId: string;
  const connected = new Set<string>();
  const pushed: string[] = [];

  before(async () => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-clear-')));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    db = new Db(':memory:');
    coord = new Coordinator(db, new Bus());
    coord.setPushTarget({
      push: (id) => {
        if (!connected.has(id)) return false;
        pushed.push(id);
        return true;
      },
      isConnected: (id) => connected.has(id),
      rekey: (oldId, newId) => {
        if (!connected.delete(oldId)) return false;
        connected.add(newId);
        return true;
      },
    });
    repoId = (await coord.registerAgent({ sessionId: 'old11111', cwd: dir, name: 'mara', hasChannel: true })).repo_id;
    connected.add('old11111');
    await coord.registerAgent({ sessionId: 'peer2222', cwd: dir, name: 'nils' });
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retires the conversation it used to be, and frees what that was holding', async () => {
    coord.setIntent('old11111', 'rewriting the importer', []);
    coord.claim('old11111', ['src/import/**'], true, 'importer', 240);

    coord.sessionReplaced('old11111', 'new33333');
    await coord.registerAgent({ sessionId: 'new33333', cwd: dir, name: 'mara' });

    assert.equal(coord.agent('old11111')!.status, 'offline', 'the conversation that ended is off the board');
    assert.equal(
      (await coord.preEdit('peer2222', path.join(dir, 'src', 'import', 'csv.ts'))).deny,
      undefined,
      'and it is not still holding a lock nobody can release',
    );
    assert.equal(coord.agent('new33333')!.name, 'mara', 'the terminal keeps its name rather than becoming mara-2');
    assert.equal(coord.agent('new33333')!.intent, null, 'but not an intent it has no memory of');
  });

  it('carries the channel across, so questions still reach the terminal', () => {
    assert.ok(!connected.has('old11111'));
    assert.ok(connected.has('new33333'), 'the shim socket is the same socket, under the id that is now live');

    pushed.length = 0;
    coord.send('peer2222', repoId, 'mara', 'question', 'is the importer yours?');
    assert.deepEqual(pushed, ['new33333'], 'pushed to the session that is actually there');
  });

  it('carries over what was asked of it and never shown', async () => {
    // A question reaches a connected session at once, so that one has had its chance; an info
    // waits for a hook, and the clear happens before one arrives.
    const seen = coord.send('peer2222', repoId, 'mara', 'question', 'already delivered, already missed');
    const unseen = coord.send('peer2222', repoId, 'mara', 'info', 'never shown to anyone');

    coord.sessionReplaced('new33333', 'new44444');
    await coord.registerAgent({ sessionId: 'new44444', cwd: dir, name: 'mara' });

    const to = (id: number): string | null => coord.raw.get<{ to_id: string }>('SELECT to_id FROM messages WHERE id = ?', id)!.to_id;
    assert.equal(to(unseen.id), 'new44444', 'a question nobody has answered follows the terminal');
    assert.equal(to(seen.id), 'new33333', 'one the cleared conversation already had its chance at does not');
    assert.match(coord.piggyback('new44444') ?? '', /never shown to anyone/);
  });

  it('does nothing when the id has not actually changed', () => {
    const before = coord.agent('new44444')!.status;
    coord.sessionReplaced('new44444', 'new44444');
    assert.equal(coord.agent('new44444')!.status, before);
  });
});
