import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Bus } from '../src/daemon/bus.ts';
import { Coordinator, type PushTarget } from '../src/daemon/coord.ts';
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'));
    db = new Db(':memory:');
    coord = new Coordinator(db, new Bus());
    const target: PushTarget = {
      push: (agentId, content, meta) => {
        if (!channelAgents.has(agentId)) return false;
        pushed.push({ agentId, content, meta });
        return true;
      },
      isConnected: (id) => channelAgents.has(id),
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

  it('re-groups an agent that moves to another repo', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-other-'));
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
    coord.setPushTarget({ push: () => false, isConnected: () => false });
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

  it('ends sb_status on what this agent owes the others', async () => {
    const status = coord.statusText('n1111111');
    assert.match(status, /Owed by you/);
    assert.match(status, /sb_intent/, 'it never announced a task');
  });
});
