import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bodyShape } from '../src/daemon/server.ts';

describe('what the request log repeats of a body', () => {
  it('keeps flags and numbers, which say what was asked', () => {
    assert.deepEqual(bodyShape({ force: true, weight: 2, target: null }), { force: true, weight: 2, target: null });
  });

  it('never repeats text or anything nested, which is where codes and messages live', () => {
    const shape = bodyShape({ code: '123456', body: 'a message', settings: { token: 'x' }, tags: ['a'] });
    assert.deepEqual(shape, { code: 'string', body: 'string', settings: 'object', tags: 'object' });
    assert.ok(!JSON.stringify(shape).includes('123456'));
  });

  it('says nothing for an empty body', () => {
    assert.equal(bodyShape({}), undefined);
  });
});
