import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accountMismatch } from '../src/daemon/subscriptions.ts';

/**
 * A subscription says which account it is for; its token says which account it is on. These were
 * one field, and the profile fetch wrote the second over the first — so a subscription logged into
 * the wrong account renamed its own expectation to match and went on reporting a stranger's usage
 * under the label of the account it was meant to be. Worse when both accounts are on the desk: one
 * pool is then ranked twice, and work is spread across capacity that does not exist.
 */
describe('which account a subscription is really on', () => {
  it('says nothing when either side is unknown', () => {
    // Created without an address: it is for whatever it was logged into, so there is no claim to break.
    assert.equal(accountMismatch(null, 'devops@apex-automata.com'), false);
    // Logged in but never polled: nothing to compare against yet, and a guess here disables a
    // perfectly good subscription.
    assert.equal(accountMismatch('info@apex-automata.com', null), false);
    assert.equal(accountMismatch(null, null), false);
  });

  it('accepts the same address however it was typed', () => {
    assert.equal(accountMismatch('Info@Apex-Automata.com', 'info@apex-automata.com'), false);
    assert.equal(accountMismatch(' info@apex-automata.com ', 'info@apex-automata.com'), false);
  });

  it('catches the one that started this: a token issued for another account', () => {
    assert.equal(accountMismatch('info@apex-automata.com', 'devops@apex-automata.com'), true);
  });
});
