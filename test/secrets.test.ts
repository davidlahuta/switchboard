import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/*
 * The repository is public. Nothing that is a credential, or that says where this desk is, goes into
 * it: this fails the suite (and so every push made after `npm test`) on anything that looks like one.
 * GitHub's own secret scanning blocks known provider tokens at push; this also covers what it does
 * not know: logins in Claude Code's own format, private keys, tailnet names, people's addresses.
 *
 * Patterns only, deliberately: a guard that listed the real values would publish them itself.
 */

const root = path.resolve(import.meta.dirname, '..');

const CREDENTIALS: Array<[string, RegExp]> = [
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['Anthropic key or OAuth token', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['API key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ['AWS key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  // A key, not the placeholder that says where one goes: base64 follows the header.
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*(\\n)?[A-Za-z0-9+/=]{40,}/],
  ['Azure key', /(AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{20,}/],
  ['Azure SAS signature', /[?&]sig=[A-Za-z0-9%+/=]{20,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['OAuth token in JSON', /"(accessToken|refreshToken|access_token|refresh_token|client_secret|clientSecret)"\s*:\s*"[A-Za-z0-9._~+/=-]{24,}"/],
  ['credentials in a URL', /https?:\/\/[^\s/:@"'`]+:[^\s/@"'`$]{6,}@/],
];

const IDENTIFYING: Array<[string, RegExp]> = [
  // A real tailnet's name; documentation uses <tailnet> or example names.
  ['tailnet name', /\btail[0-9a-f]{6}\.ts\.net\b/],
  // Addresses on example domains, GitHub's noreply and placeholders are fine; anybody's real one is
  // not. `git@host` is the user name of an SSH remote, and `user:token@host` a URL's, not addresses;
  // the URL form is the credential check's to judge.
  ['email address', /(?<![:/\w.%+-])(?!git@)[A-Za-z0-9._%+-]+@(?!(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|users\.noreply\.github\.com|anthropic\.com|t)\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/i],
];

function trackedFiles(): string[] {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

describe('the public repository', () => {
  it('holds no credentials and nothing that identifies a desk or a person', () => {
    const found: string[] = [];
    for (const rel of trackedFiles()) {
      if (rel === 'test/secrets.test.ts' || rel === 'package-lock.json') continue;
      const file = path.join(root, rel);
      let text: string;
      try {
        if (fs.statSync(file).size > 2_000_000) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // deleted in the working tree
      }
      if (text.includes('\u0000')) continue;
      for (const [what, re] of [...CREDENTIALS, ...IDENTIFYING]) {
        const m = text.match(re);
        if (m) found.push(`${rel}: ${what} (${m[0].slice(0, 12)}…)`);
      }
    }
    assert.deepEqual(found, [], `Not for a public repository:\n${found.join('\n')}`);
  });
});
