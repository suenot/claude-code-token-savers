import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from '../src/watchdog/estimate.ts';

test('empty body → 0', () => {
  assert.equal(estimateTokens({}), 0);
  assert.equal(estimateTokens({ messages: [] }), 0);
});

test('counts system string + message text (chars/4)', () => {
  // system 'abcd' (4) + user 'efgh' (4) = 8 chars → 2 tokens
  const n = estimateTokens({ system: 'abcd', messages: [{ role: 'user', content: 'efgh' }] });
  assert.equal(n, 2);
});

test('counts system blocks and message blocks', () => {
  const body = {
    system: [{ type: 'text', text: 'aa' }, { type: 'text', text: 'bb' }], // 4
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'cccc' }] }], // 4
  };
  assert.equal(estimateTokens(body), 2); // 8/4
});

test('rounds up', () => {
  assert.equal(estimateTokens({ messages: [{ role: 'user', content: 'abcde' }] }), 2); // 5/4 → 2
});
