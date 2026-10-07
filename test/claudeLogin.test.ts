import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanLoginCode, loginUrlIn, plainText } from '../src/daemon/claudeLogin.ts';

/**
 * `claude auth login` run by the daemon, finished from the web app: the link has to be read out of
 * what claude prints for a terminal, and the code that comes back must be one line and nothing more.
 */
describe('signing a subscription in from the web app', () => {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz';

  it('finds the link inside the OSC 8 hyperlink claude wraps it in', () => {
    const printed = `Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `;
    assert.equal(loginUrlIn(printed), url);
    assert.doesNotMatch(plainText(printed), /\x1b/);
  });

  it('finds nothing before the link is printed', () => {
    assert.equal(loginUrlIn('Opening browser to sign in…\n'), null);
  });

  it('takes a code as pasted, and refuses anything that could be a second answer', () => {
    assert.equal(cleanLoginCode('  abc123#state456 \n'), 'abc123#state456');
    assert.equal(cleanLoginCode('abc\nrm -rf'), null);
    assert.equal(cleanLoginCode('a b'), null);
    assert.equal(cleanLoginCode(''), null);
    assert.equal(cleanLoginCode(42), null);
    assert.equal(cleanLoginCode('x'.repeat(5000)), null);
  });
});
