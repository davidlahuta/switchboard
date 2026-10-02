import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { originOf, pathKey, repoFromFiles, resolveRepo } from '../src/git.ts';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** What git itself says, in the shape resolveRepo answers with. */
function asked(dir: string): { root: string; worktree: string; branch: string | null } | null {
  try {
    const [common, top] = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel').split(/\r?\n/);
    let branch: string | null = null;
    try {
      branch = git(dir, 'symbolic-ref', '--quiet', '--short', 'HEAD') || null;
    } catch {
      branch = null;
    }
    return { root: path.resolve(path.basename(common) === '.git' ? path.dirname(common) : common), worktree: path.resolve(top), branch };
  } catch {
    return null;
  }
}

describe('reading where a directory sits in git from its files', () => {
  let base: string;
  let repo: string;
  let linked: string;
  let sub: string;

  before(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-git-')));
    repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/repo.git');
    fs.writeFileSync(path.join(repo, 'src', 'deep', 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    linked = path.join(base, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', linked);
    const lib = path.join(base, 'lib');
    fs.mkdirSync(lib);
    git(lib, 'init', '-q', '-b', 'trunk');
    fs.writeFileSync(path.join(lib, 'l.txt'), 'l');
    git(lib, 'add', '.');
    git(lib, 'commit', '-q', '-m', 'lib');
    git(repo, 'submodule', 'add', '-q', lib, 'vendor/lib');
    sub = path.join(repo, 'vendor', 'lib');
  });

  after(() => fs.rmSync(base, { recursive: true, force: true }));

  it('answers as git does for a repository, a subfolder, a linked worktree and a submodule', async () => {
    for (const dir of [repo, path.join(repo, 'src', 'deep'), linked, path.join(linked, 'src'), sub]) {
      const files = await repoFromFiles(dir);
      const want = asked(dir);
      assert.ok(files && want, dir);
      assert.equal(pathKey(files.root), pathKey(want.root), `root of ${dir}`);
      assert.equal(pathKey(files.worktree), pathKey(want.worktree), `worktree of ${dir}`);
      assert.equal(files.branch, want.branch, `branch of ${dir}`);
    }
  });

  it('files a linked worktree under the repository it belongs to', async () => {
    const info = await repoFromFiles(path.join(linked, 'src'));
    assert.equal(pathKey(info!.root), pathKey(repo));
    assert.equal(info!.branch, 'feature/x');
  });

  it('says no branch for a detached HEAD, as git does', async () => {
    const detached = path.join(base, 'detached');
    git(repo, 'worktree', 'add', '-q', '--detach', detached);
    assert.equal((await repoFromFiles(detached))!.branch, null);
    assert.equal(asked(detached)!.branch, null);
  });

  it('says not a repository outside one, and leaves the inside of .git to git', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-nogit-'));
    try {
      assert.equal(await repoFromFiles(outside), null);
      assert.equal(await repoFromFiles(path.join(base, 'missing')), null);
      assert.equal(await repoFromFiles(path.join(repo, '.git')), undefined);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('follows an include to the origin, as git does', async () => {
    const inc = path.join(base, 'extra.gitconfig');
    fs.writeFileSync(inc, '[remote "origin"]\n\turl = https://github.com/acme/moved.git\n');
    git(repo, 'config', 'include.path', inc);
    try {
      const { originOf: fresh } = await import(`../src/git.ts?include=${Date.now()}`);
      assert.equal(await fresh(repo), git(repo, 'config', '--get', 'remote.origin.url'));
      assert.equal(await fresh(repo), 'https://github.com/acme/moved.git');
    } finally {
      git(repo, 'config', '--unset', 'include.path');
    }
  });

  it('reads the origin from the config file', async () => {
    assert.equal(await originOf(repo), 'https://github.com/acme/repo.git');
    const info = await resolveRepo(linked);
    assert.equal(await originOf(info.root), 'https://github.com/acme/repo.git');
  });
});
