import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { osc52Text } from '../web/src/lib/clipboard.ts';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('what Claude Code copies, arriving in the web terminal', () => {
  it('is the text of the selection', () => {
    // Exactly what Claude Code sent for a selection across its banner.
    assert.equal(osc52Text('c;IENsYXVkZSBDb2RlIHYyLjEuMjgw'), ' Claude Code v2.1.280');
  });

  it('keeps anything that is not plain ASCII intact', () => {
    assert.equal(osc52Text(`c;${b64('Příliš žluťoučký kůň — 日本語 ✓')}`), 'Příliš žluťoučký kůň — 日本語 ✓');
  });

  it('never answers a request to read the clipboard, or anything malformed', () => {
    assert.equal(osc52Text('c;?'), null, 'a session may not read the viewer’s clipboard');
    assert.equal(osc52Text('c;'), null);
    assert.equal(osc52Text('garbage'), null);
    assert.equal(osc52Text('c;%%%not base64%%%'), null);
  });
});
