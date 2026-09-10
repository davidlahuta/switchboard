import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Bus } from '../src/daemon/bus.ts';
import { Coordinator, type PushTarget } from '../src/daemon/coord.ts';
import { Db } from '../src/daemon/db.ts';
import { matchesPattern, patternsOverlap, relPath } from '../src/git.ts';

describe('path matching', () => {
  it('matches exact files, directories and globs', () => {
    assert.ok(matchesPattern('src/a.ts', 'src/a.ts'));
    assert.ok(matchesPattern('src/auth/login.ts', 'src/auth'));
    assert.ok(matchesPattern('src/auth/login.ts', 'src/auth/'));
    assert.ok(matchesPattern('src/auth/deep/x.ts', 'src/auth/**'));
    assert.ok(matchesPattern('src/a.ts', './src/*.ts'));
    assert.ok(!matchesPattern('src/a/b.ts', 'src/*.ts'));
    assert.ok(!matchesPattern('src/authz.ts', 'src/auth'));
  });

  it('detects overlapping patterns', () => {
    assert.ok(patternsOverlap('src/auth/**', 'src/auth/login.ts'));
    assert.ok(patternsOverlap('src', 'src/auth/**'));
    assert.ok(!patternsOverlap('src/auth/**', 'docs/**'));
  });

  it('computes repo-relative paths', () => {
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

  before(() => {
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

  it('groups agents by repo and names them uniquely', () => {
    const a = coord.registerAgent({ sessionId: 'aaaa1111', cwd: dir, name: 'alpha' });
    const b = coord.registerAgent({ sessionId: 'bbbb2222', cwd: dir, name: 'alpha', hasChannel: true });
    channelAgents.add(b.id);
    assert.equal(a.repo_id, b.repo_id);
    assert.equal(a.name, 'alpha');
    assert.equal(b.name, 'alpha-2');
  });

  it('pushes questions immediately and defers info broadcasts to hooks', () => {
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

  it('warns on overlapping edits and notifies the other agent', () => {
    const file = path.join(dir, 'src', 'shared.ts');
    assert.equal(coord.recordEdit('aaaa1111', file, 'Edit'), null);
    const warning = coord.recordEdit('bbbb2222', file, 'Edit');
    assert.match(warning ?? '', /src\/shared\.ts/);
    assert.match(warning ?? '', /alpha/);
    const detail = coord.repoDetail(coord.agent('aaaa1111')!.repo_id)!;
    assert.equal(detail.conflicts.filter((c) => c.status === 'open').length, 1);
    // alpha has no channel: the conflict notice waits for its next hook
    assert.match(coord.piggyback('aaaa1111') ?? '', /just edited src\/shared\.ts/);
  });

  it('blocks edits inside another agent’s exclusive claim', () => {
    coord.claim('aaaa1111', ['src/billing/**'], true, 'migrating billing', 30);
    const verdict = coord.preEdit('bbbb2222', path.join(dir, 'src', 'billing', 'invoice.ts'));
    assert.match(verdict.deny ?? '', /exclusively claimed/);
    assert.equal(coord.preEdit('aaaa1111', path.join(dir, 'src', 'billing', 'invoice.ts')).deny, undefined);
    coord.release('aaaa1111');
    assert.equal(coord.preEdit('bbbb2222', path.join(dir, 'src', 'billing', 'invoice.ts')).deny, undefined);
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

  it('identifies sessions by GUID, treating names as reusable aliases', () => {
    const repoId = coord.agent('aaaa1111')!.repo_id;
    // The session id always wins, even when a display name would be ambiguous.
    assert.equal(coord.findAgent(repoId, 'aaaa1111')?.id, 'aaaa1111');
    assert.equal(coord.findAgent(repoId, 'bbbb2222')?.id, 'bbbb2222');

    // A name freed by an offline session can be taken by a new one; the old GUID still resolves.
    const original = coord.agent('aaaa1111')!;
    coord.markOffline('aaaa1111', 'test');
    const reuser = coord.registerAgent({ sessionId: 'cccc3333', cwd: dir, name: original.name });
    assert.equal(reuser.name, original.name, 'name is reusable once the holder is offline');
    assert.equal(coord.findAgent(repoId, original.name)?.id, 'cccc3333', 'the live agent wins the alias');
    assert.equal(coord.findAgent(repoId, 'aaaa1111')?.id, 'aaaa1111', 'the GUID still resolves the old session');

    // An ambiguous name is refused rather than guessed.
    coord.registerAgent({ sessionId: 'aaaa1111', cwd: dir });
    coord.raw.run('UPDATE agents SET name = ? WHERE id = ?', original.name, 'aaaa1111');
    assert.throws(() => coord.findAgent(repoId, original.name), /matches 2 live agents/);

    coord.raw.run('UPDATE agents SET name = ? WHERE id = ?', 'alpha', 'aaaa1111');
    coord.markOffline('cccc3333', 'test');
  });

  it('re-groups an agent that moves to another repo', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-other-'));
    try {
      const before = coord.agent('aaaa1111')!;
      coord.claim('aaaa1111', ['src/**'], false, null, 30);
      coord.setIntent('aaaa1111', 'work in the first repo', []);
      coord.setCwd('aaaa1111', other);
      const after = coord.agent('aaaa1111')!;
      assert.notEqual(after.repo_id, before.repo_id, 'agent must join the new repo group');
      assert.equal(after.intent, null, 'intent belonged to the old repo');
      assert.equal(coord.repoDetail(before.repo_id)!.claims.filter((c) => c.agentId === 'aaaa1111').length, 0);
      // and it is gone from the old repo's roster
      assert.ok(!coord.repoDetail(before.repo_id)!.agents.some((x) => x.id === 'aaaa1111'));
      coord.setCwd('aaaa1111', dir); // move back for the remaining tests
      assert.equal(coord.agent('aaaa1111')!.repo_id, before.repo_id);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps a non-channel agent working when someone waits on it', () => {
    const repoId = coord.agent('aaaa1111')!.repo_id;
    coord.piggyback('aaaa1111');
    coord.send('bbbb2222', repoId, 'alpha', 'request', 'please rebase on main');
    assert.match(coord.stopBlockReason('aaaa1111') ?? '', /please rebase on main/);
    assert.equal(coord.stopBlockReason('aaaa1111'), null);
  });
});
