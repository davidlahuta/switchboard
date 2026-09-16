import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Bus } from '../src/daemon/bus.ts';
import { agentName, comparablePath, Coordinator } from '../src/daemon/coord.ts';
import { Db } from '../src/daemon/db.ts';

const back = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A board with two agents in one directory, rebuilt for every test so none leans on another. */
describe('a board that tidies up after itself', () => {
  let dir: string;
  let db: Db;
  let coord: Coordinator;
  let repoId: string;
  const ended = new Set<string>();
  const runNames = new Map<string, string>();
  const file = (...parts: string[]): string => path.join(dir, ...parts);
  const open = (): number => coord.raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM conflicts WHERE status = 'open'")!.n;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tidy-'));
  });

  beforeEach(async () => {
    db?.close();
    ended.clear();
    runNames.clear();
    db = new Db(':memory:');
    coord = new Coordinator(db, new Bus());
    coord.setPushTarget({ push: () => false, isConnected: () => false, rekey: () => false });
    coord.setSessionGone((id) => ended.has(id));
    coord.setRunName((id) => runNames.get(id) ?? null);
    repoId = (await coord.registerAgent({ sessionId: 'a1111111', cwd: dir, name: 'ada' })).repo_id;
    await coord.registerAgent({ sessionId: 'b2222222', cwd: dir, name: 'ben' });
  });

  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('claims', () => {
    it('releases a claim once it has expired, and every claim of an agent that has left', () => {
      coord.claim('a1111111', ['src/a/**'], false, null, 30);
      coord.claim('b2222222', ['src/b/**'], false, null, 30);
      coord.raw.run("UPDATE claims SET expires_at = ? WHERE pattern = 'src/a/**'", back(60_000));
      coord.raw.run("UPDATE agents SET status = 'offline' WHERE id = 'b2222222'"); // gone without markOffline, as the stale shims left them

      assert.equal(coord.releaseLapsedClaims(), 2);
      assert.equal(coord.raw.get<{ n: number }>('SELECT COUNT(*) AS n FROM claims WHERE released_at IS NULL')!.n, 0);
      assert.equal(coord.raw.get<{ r: string; e: string }>("SELECT released_at AS r, expires_at AS e FROM claims WHERE pattern = 'src/a/**'")!.r, coord.raw.get<{ e: string }>("SELECT expires_at AS e FROM claims WHERE pattern = 'src/a/**'")!.e, 'released when it expired, not when it was noticed');
    });
  });

  describe('conflicts', () => {
    it('records an edit inside an exclusive claim, and only warns about one inside a soft claim', async () => {
      coord.claim('b2222222', ['src/soft/**'], false, 'reading', 60);
      const soft = await coord.recordEdit('a1111111', file('src', 'soft', 'x.ts'), 'Edit');
      assert.match(soft ?? '', /inside ben's claim/, 'the warning still goes out');
      assert.equal(open(), 0, 'but a heads-up is not a conflict');

      coord.claim('b2222222', ['src/hard/**'], true, 'rewriting', 60);
      await coord.recordEdit('a1111111', file('src', 'hard', 'x.ts'), 'Edit');
      assert.equal(open(), 1);
    });

    it('records two agents editing one file only when they share a worktree', async () => {
      await coord.recordEdit('b2222222', file('src', 'shared.ts'), 'Edit');
      // Moved after the edit: the path is worked out against the worktree the agent is in.
      const tree = coord.agent('b2222222')!.worktree;
      coord.raw.run("UPDATE agents SET worktree = ? WHERE id = 'b2222222'", path.join(dir, 'elsewhere'));
      const warned = await coord.recordEdit('a1111111', file('src', 'shared.ts'), 'Edit');
      assert.match(warned ?? '', /ben/, 'both still hear about it');
      assert.equal(open(), 0, 'separate worktrees meet at a merge, not here');

      coord.raw.run("UPDATE agents SET worktree = ? WHERE id = 'b2222222'", tree);
      await coord.recordEdit('b2222222', file('src', 'shared.ts'), 'Edit');
      assert.equal(open(), 1);
    });

    it('closes a conflict once one side has left, its claim is gone, or nobody has edited the file for a while', async () => {
      coord.claim('b2222222', ['src/hard/**'], true, null, 60);
      await coord.recordEdit('a1111111', file('src', 'hard', 'x.ts'), 'Edit');
      await coord.recordEdit('b2222222', file('src', 'same.ts'), 'Edit');
      await coord.recordEdit('a1111111', file('src', 'same.ts'), 'Edit');
      assert.equal(open(), 2);

      assert.equal(coord.closeSettledConflicts(repoId), 0, 'nothing has changed yet');

      coord.release('b2222222');
      assert.equal(coord.closeSettledConflicts(repoId), 1);
      assert.equal(coord.raw.get<{ r: string }>("SELECT resolution AS r FROM conflicts WHERE kind = 'claim'")!.r, 'no exclusive claim covers it any more');

      coord.raw.run('UPDATE file_touches SET ts = ?', back(DAY));
      assert.equal(coord.closeSettledConflicts(repoId), 1);
      assert.match(coord.raw.get<{ r: string }>("SELECT resolution AS r FROM conflicts WHERE kind = 'overlap'")!.r, /neither has edited it/);
    });

    it('closes the ones between agents that have gone, which is most of what was left open', async () => {
      coord.claim('b2222222', ['src/hard/**'], true, null, 60);
      await coord.recordEdit('a1111111', file('src', 'hard', 'x.ts'), 'Edit');
      coord.markOffline('b2222222', 'test');
      coord.sweep();
      assert.equal(open(), 0);
      assert.equal(coord.raw.get<{ r: string }>('SELECT resolution AS r FROM conflicts')!.r, 'ben has left');
    });
  });

  describe('a conversation that has left the board', () => {
    it('is refused when another session holds its terminal now', async () => {
      await coord.registerAgent({ sessionId: 'c3333333', cwd: dir, name: 'cy', runId: 'run-c' });
      coord.markOffline('c3333333', 'test');
      await coord.registerAgent({ sessionId: 'c4444444', cwd: dir, name: 'cy-now', runId: 'run-c' });

      const r = await coord.runTool('c3333333', 'sb_intent', { summary: 'still here?', files: ['src/**'] });
      assert.equal(r.isError, true);
      assert.match(r.text, /left the board/);
      assert.equal(coord.raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM claims WHERE agent_id = 'c3333333'")!.n, 0, 'and leaves no claims behind');
    });

    it('is refused when its run has ended', async () => {
      coord.markOffline('b2222222', 'test');
      ended.add('b2222222');
      assert.equal((await coord.runTool('b2222222', 'sb_claim', { paths: ['src/**'] })).isError, true);
    });

    it('is back on the board when nothing says it is over: it is plainly talking', async () => {
      coord.markOffline('b2222222', 'no activity');
      const r = await coord.runTool('b2222222', 'sb_status', {});
      assert.equal(r.isError, false);
      assert.notEqual(coord.agent('b2222222')!.status, 'offline');
    });
  });

  describe('one name per session', () => {
    it('names a hosted agent after its session, and keeps it there', async () => {
      runNames.set('run-d', '0219 durable actions');
      await coord.registerAgent({ sessionId: 'd5555555', cwd: dir, name: '0219 durable actions', runId: 'run-d' });
      assert.equal(coord.agent('d5555555')!.name, '0219-durable-actions', 'spaces and hyphens are one name');

      const r = await coord.runTool('d5555555', 'sb_intent', { summary: 'lane work', name: 'lane6-launch-dsr' });
      assert.equal(coord.agent('d5555555')!.name, '0219-durable-actions', 'an intent does not rename a hosted session');
      assert.match(r.text, /follows your session's name/);

      coord.raw.run("UPDATE agents SET name = 'idle-2' WHERE id = 'd5555555'");
      coord.piggyback('d5555555');
      coord.sweep();
      assert.equal(coord.agent('d5555555')!.name, '0219-durable-actions', 'a name that drifted is put back');
      assert.match(coord.piggyback('d5555555') ?? '', /Your name on this board is now "0219-durable-actions".*it was "idle-2"/, 'and the agent is told');
      assert.equal(coord.findAgent(repoId, 'idle-2')?.id, 'd5555555', 'peers still using the old name reach it');
    });

    it('lets an unhosted agent name itself as before', async () => {
      await coord.runTool('a1111111', 'sb_intent', { summary: 'x', name: 'ada two' });
      assert.equal(coord.agent('a1111111')!.name, 'ada-two');
    });

    it('finds a session by the name the operator sees, spaces or not', () => {
      assert.equal(coord.findAgent(repoId, 'ADA')?.id, 'a1111111');
      assert.equal(agentName('  remaining   specs '), 'remaining-specs');
    });

    it('sends what is addressed to a replaced conversation to the session in its terminal', async () => {
      await coord.registerAgent({ sessionId: 'e6666666', cwd: dir, name: 'eve', runId: 'run-e' });
      const stranded = coord.send('a1111111', repoId, 'eve', 'handoff', 'yours now');
      const reminder = coord.send('switchboard', repoId, 'eve', 'info', 'You have held a claim on "x"');
      const stale = coord.send('a1111111', repoId, 'eve', 'info', 'from the day before yesterday');
      coord.raw.run('UPDATE messages SET created_at = ? WHERE id = ?', back(2 * DAY), stale.id);
      coord.markOffline('e6666666', 'session exited');
      await coord.registerAgent({ sessionId: 'e7777777', cwd: dir, name: 'eve', runId: 'run-e' });

      assert.equal(coord.findAgent(repoId, 'e6666666')?.id, 'e7777777', 'the old id reaches the terminal it was in');
      coord.sweep();
      const to = (id: number): string => coord.raw.get<{ t: string }>('SELECT to_id AS t FROM messages WHERE id = ?', id)!.t;
      assert.equal(to(stranded.id), 'e7777777');
      assert.equal(to(reminder.id), 'e6666666', 'a reminder about what the old conversation held stays with it');
      assert.equal(to(stale.id), 'e6666666', 'and so does what is too old to be news');
      assert.match(coord.piggyback('e7777777') ?? '', /yours now/);
    });

    it('hides a replaced conversation from the board, and keeps one that simply ended', async () => {
      await coord.registerAgent({ sessionId: 'f8888888', cwd: dir, name: 'fay', runId: 'run-f' });
      coord.markOffline('f8888888', 'cleared');
      await coord.registerAgent({ sessionId: 'f9999999', cwd: dir, name: 'fay', runId: 'run-f' });
      coord.markOffline('b2222222', 'ended');
      const shown = coord.repoDetail(repoId)!.agents.map((a) => a.id);
      assert.ok(!shown.includes('f8888888'));
      assert.ok(shown.includes('f9999999'));
      assert.ok(shown.includes('b2222222'));
    });
  });

  describe('lanes', () => {
    const openClaims = (): string[] =>
      coord.raw
        .all<{ pattern: string; lane: string | null }>("SELECT pattern, lane FROM claims WHERE agent_id = 'a1111111' AND released_at IS NULL ORDER BY pattern")
        .map((c) => `${c.lane ?? '-'}:${c.pattern}`);

    it('keeps each line of work its own intent and claims, apart from the session and each other', async () => {
      await coord.runTool('a1111111', 'sb_intent', { summary: 'orchestrating the launch gaps', files: ['.docs/plan.md'] });
      await coord.runTool('a1111111', 'sb_intent', { summary: 'suspension specs', files: ['.docs/specs/0470-*'], lane: 'lane6' });
      await coord.runTool('a1111111', 'sb_intent', { summary: 'tier limits', files: ['.docs/specs/0466-*'], lane: 'lane4' });
      await coord.runTool('a1111111', 'sb_intent', { summary: 'suspension and erasure', files: ['.docs/specs/0470-*', '.docs/specs/0474-*'], lane: 'lane6' });

      assert.equal(coord.agent('a1111111')!.intent, 'orchestrating the launch gaps', 'a lane does not replace the session\'s own intent');
      assert.deepEqual(openClaims(), ['-:.docs/plan.md', 'lane4:.docs/specs/0466-*', 'lane6:.docs/specs/0470-*', 'lane6:.docs/specs/0474-*']);
      const status = coord.statusText('b2222222');
      assert.match(status, /lanes: .*lane6: "suspension and erasure"/);
      assert.match(status, /lanes: .*lane4: "tier limits"/);
      assert.deepEqual(coord.repoDetail(repoId)!.agents.find((x) => x.id === 'a1111111')!.lanes.map((l) => l.lane).sort(), ['lane4', 'lane6']);
    });

    it('releases one lane and ends it, leaving the rest', async () => {
      await coord.runTool('a1111111', 'sb_intent', { summary: 'suspension', files: ['s/**'], lane: 'lane6' });
      await coord.runTool('a1111111', 'sb_claim', { paths: ['t/**'], lane: 'lane4' });
      const r = await coord.runTool('a1111111', 'sb_release', { lane: 'lane6' });
      assert.match(r.text, /Released 1 claim\(s\) and ended lane "lane6"/);
      assert.deepEqual(openClaims(), ['lane4:t/**']);
      assert.deepEqual(coord.repoDetail(repoId)!.agents.find((x) => x.id === 'a1111111')!.lanes.map((l) => l.lane), []);
    });

    it('ends a lane nobody renewed, and every lane of a session that has left', async () => {
      await coord.runTool('a1111111', 'sb_intent', { summary: 'old', lane: 'stale' });
      await coord.runTool('b2222222', 'sb_intent', { summary: 'x', lane: 'gone' });
      coord.raw.run("UPDATE lanes SET updated_at = ? WHERE lane = 'stale'", back(5 * HOUR));
      coord.markOffline('b2222222', 'ended');
      coord.sweep();
      assert.equal(coord.raw.get<{ n: number }>('SELECT COUNT(*) AS n FROM lanes')!.n, 0);
    });
  });

  describe('questions nobody answers', () => {
    it('stop being owed after six hours, and the asker is told once', () => {
      const q = coord.send('a1111111', repoId, 'ben', 'request', 'review my branch?');
      coord.raw.run('UPDATE messages SET created_at = ? WHERE id = ?', back(7 * HOUR), q.id);
      assert.match(coord.statusText('b2222222'), new RegExp(`Answer #${q.id}`));

      coord.sweep();
      assert.ok(coord.raw.get<{ l: string | null }>('SELECT lapsed_at AS l FROM messages WHERE id = ?', q.id)!.l);
      assert.doesNotMatch(coord.statusText('b2222222'), new RegExp(`Answer #${q.id}`), 'no longer on ben\'s list');
      assert.match(coord.piggyback('a1111111') ?? '', new RegExp(`#${q.id} to ben .*no answer for 6h`));

      coord.sweep();
      assert.equal(coord.piggyback('a1111111'), null, 'said once');
    });

    it('lapse quietly when they are older than anybody still waits for', () => {
      const q = coord.send('a1111111', repoId, 'ben', 'question', 'from last week');
      coord.raw.run('UPDATE messages SET created_at = ? WHERE id = ?', back(5 * DAY), q.id);
      coord.piggyback('a1111111');
      coord.sweep();
      assert.ok(coord.raw.get<{ l: string | null }>('SELECT lapsed_at AS l FROM messages WHERE id = ?', q.id)!.l);
      assert.equal(coord.piggyback('a1111111'), null);
    });

    it('are not lapsed once answered', () => {
      const q = coord.send('a1111111', repoId, 'ben', 'question', 'ok?');
      coord.send('b2222222', repoId, 'ada', 'info', 'ok', false, q.id);
      coord.raw.run('UPDATE messages SET created_at = ? WHERE id = ?', back(7 * HOUR), q.id);
      coord.sweep();
      assert.equal(coord.raw.get<{ l: string | null }>('SELECT lapsed_at AS l FROM messages WHERE id = ?', q.id)!.l, null);
    });
  });

  describe('notes', () => {
    it('replaces a note in place: the old one is archived, the new one keeps its kind and pin', async () => {
      const first = coord.note('a1111111', repoId, 'decision', 'specs 0431-0433 are taken', true);
      const r = await coord.runTool('b2222222', 'sb_note', { body: 'specs 0431-0437 are taken', replaces: first.id });
      assert.equal(r.isError, false);
      assert.match(r.text, new RegExp(`replacing #${first.id}`));
      const rows = coord.raw.all<{ id: number; kind: string; pinned: number; archived_at: string | null }>('SELECT id, kind, pinned, archived_at FROM notes ORDER BY id');
      assert.ok(rows[0].archived_at);
      assert.deepEqual([rows[1].kind, rows[1].pinned, rows[1].archived_at], ['decision', 1, null]);

      const bad = await coord.runTool('b2222222', 'sb_note', { body: 'again', replaces: first.id });
      assert.equal(bad.isError, true, 'an archived note cannot be replaced twice');
    });

    it('keeps no more than 25 pinned, unpinning the oldest that is not a decision', () => {
      const ruling = coord.note('a1111111', repoId, 'decision', 'the ruling', true);
      const oldest = coord.note('a1111111', repoId, 'fact', 'oldest fact', true);
      for (let i = 0; i < 24; i++) coord.note('a1111111', repoId, 'warning', `warning ${i}`, true);
      const pinned = (id: number): number => coord.raw.get<{ p: number }>('SELECT pinned AS p FROM notes WHERE id = ?', id)!.p;
      assert.equal(pinned(oldest.id), 0);
      assert.equal(pinned(ruling.id), 1, 'the older decision stays');
      assert.equal(coord.raw.get<{ n: number }>('SELECT COUNT(*) AS n FROM notes WHERE pinned = 1')!.n, 25);
    });

    it('shows a new session its decisions first', () => {
      coord.note('a1111111', repoId, 'decision', 'THE RULING', true);
      for (let i = 0; i < 10; i++) coord.note('a1111111', repoId, 'fact', `fact ${i}`, true);
      const digest = coord.digest('b2222222');
      assert.match(digest, /Pinned notes:\n- #\d+ \[decision\] THE RULING/);
      assert.match(digest, /and 3 more pinned/);
    });

    it('archives a todo whose author left a day ago with nobody in its place', () => {
      const todo = coord.note('b2222222', repoId, 'todo', 'finish the census', true);
      const decision = coord.note('b2222222', repoId, 'decision', 'keep this', true);
      coord.markOffline('b2222222', 'ended');
      coord.prune();
      assert.equal(coord.raw.get<{ a: string | null }>('SELECT archived_at AS a FROM notes WHERE id = ?', todo.id)!.a, null, 'not the moment it leaves');

      coord.raw.run("UPDATE agents SET ended_at = ? WHERE id = 'b2222222'", back(2 * DAY));
      coord.prune();
      assert.ok(coord.raw.get<{ a: string | null }>('SELECT archived_at AS a FROM notes WHERE id = ?', todo.id)!.a);
      assert.equal(coord.raw.get<{ a: string | null }>('SELECT archived_at AS a FROM notes WHERE id = ?', decision.id)!.a, null, 'only todos');
    });
  });

  describe('board health', () => {
    it('shows orphans until the sweep clears them, and what the sweep did', async () => {
      coord.claim('b2222222', ['src/hard/**'], true, null, 60);
      await coord.recordEdit('a1111111', file('src', 'hard', 'x.ts'), 'Edit');
      coord.raw.run("UPDATE agents SET status = 'offline' WHERE id = 'b2222222'");

      const before = coord.boardHealth(repoId)[0];
      assert.equal(before.orphans.claimsOfLeftAgents, 1);
      assert.equal(before.conflicts.open, 1);

      coord.sweep();
      const after = coord.boardHealth(repoId)[0];
      assert.deepEqual(after.orphans, { claimsOfLeftAgents: 0, expiredClaimsOpen: 0, messagesStrandedOnLeftAgents: 0, lanesOfLeftAgents: 0 });
      assert.deepEqual(after.conflicts, { open: 0, closed24h: 1, closedWhy: { 'a side has left': 1 } });
      assert.match(after.upkeep24h[0]?.summary ?? '', /Switchboard closed 1 conflict/);
    });

    it('counts who sent what and how much was delivered to whom', () => {
      coord.send('a1111111', repoId, 'all', 'info', 'x'.repeat(1000));
      coord.send('a1111111', repoId, 'ben', 'question', 'y?');
      coord.piggyback('b2222222');
      const t = coord.boardHealth(repoId)[0].traffic24h;
      assert.deepEqual(
        t.map((x) => [x.name, x.sent, x.broadcasts, x.received, x.chars]),
        [
          ['ben', 0, 0, 2, 1002],
          ['ada', 2, 1, 0, 0],
        ],
      );
      assert.equal(coord.boardHealth(repoId)[0].questions.owed, 1);
    });

    it('counts a session once, across the conversations it has had', async () => {
      await coord.registerAgent({ sessionId: 'g1111111', cwd: dir, name: 'gil', runId: 'run-g' });
      coord.send('g1111111', repoId, 'all', 'info', 'before the clear');
      coord.markOffline('g1111111', 'cleared');
      await coord.registerAgent({ sessionId: 'g2222222', cwd: dir, name: 'gil', runId: 'run-g' });
      coord.send('g2222222', repoId, 'all', 'info', 'after it');
      coord.raw.run("INSERT INTO events (repo_id, agent_id, type, summary, ts) VALUES (?, NULL, 'message', 'switchboard → gil: a reminder', ?)", repoId, new Date().toISOString());
      const h = coord.boardHealth(repoId)[0];
      const gil = h.traffic24h.filter((t) => t.name === 'gil');
      assert.deepEqual(gil.map((t) => [t.agentId, t.status, t.sent]), [['g2222222', 'starting', 2]]);
      assert.equal(h.upkeep24h.length, 0, 'a message Switchboard sent is not upkeep');
    });
  });

  describe('boards and history', () => {
    it('forgets a board in a scratch folder an hour after anyone used it, but not while anyone is on it', () => {
      assert.equal(comparablePath(os.tmpdir()), comparablePath(fs.realpathSync.native(os.tmpdir())));
      coord.raw.run('UPDATE repos SET last_activity = ? WHERE id = ?', back(2 * HOUR), repoId);
      coord.prune();
      assert.ok(coord.repoDetail(repoId), 'two agents are on it');

      coord.markOffline('a1111111', 'x');
      coord.markOffline('b2222222', 'x');
      coord.raw.run('UPDATE repos SET last_activity = ? WHERE id = ?', back(2 * HOUR), repoId);
      coord.prune();
      assert.equal(coord.repoDetail(repoId), null);
    });

    it('forgets any other board a day after its last use when there is nothing on it', () => {
      const empty = coord.ensureRepo(path.resolve('test'));
      const kept = coord.ensureRepo(path.resolve('src'));
      coord.note(null, kept.id, 'fact', 'worth keeping', false);
      coord.raw.run('UPDATE repos SET last_activity = ? WHERE id IN (?, ?)', back(2 * DAY), empty.id, kept.id);
      coord.prune();
      assert.equal(coord.repoDetail(empty.id), null);
      assert.ok(coord.repoDetail(kept.id), 'a board with a note on it is somebody\'s record');
    });

    it('drops what is over and old, and nothing that is still open', () => {
      const oldMsg = coord.send('a1111111', repoId, 'all', 'info', 'last month');
      coord.raw.run('UPDATE messages SET created_at = ? WHERE id = ?', back(31 * DAY), oldMsg.id);
      coord.claim('a1111111', ['old/**'], false, null, 60);
      coord.claim('a1111111', ['open/**'], false, null, 60);
      coord.raw.run("UPDATE claims SET released_at = ? WHERE pattern = 'old/**'", back(15 * DAY));
      coord.prune();
      assert.equal(coord.raw.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE id = ?', oldMsg.id)!.n, 0);
      assert.deepEqual(
        coord.raw.all<{ pattern: string }>('SELECT pattern FROM claims').map((c) => c.pattern),
        ['open/**'],
      );
    });
  });
});
