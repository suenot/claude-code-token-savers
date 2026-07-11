import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryKey, buildRewrittenBody } from '../src/watchdog/rewrite.ts';

test('summaryKey is stable and content-sensitive', () => {
  const a = summaryKey([{ role: 'user', content: 'x' }]);
  const b = summaryKey([{ role: 'user', content: 'x' }]);
  const c = summaryKey([{ role: 'user', content: 'y' }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('buildRewrittenBody preserves system, injects summary + ack, appends tail', () => {
  const body = { model: 'm', system: 'SYS', max_tokens: 100, messages: [{ role: 'user', content: 'orig' }] };
  const tail = [{ role: 'user', content: 'recent' }, { role: 'assistant', content: 'reply' }];
  const out = buildRewrittenBody(body, tail, 'THE SUMMARY');
  assert.equal(out.system, 'SYS');
  assert.equal(out.model, 'm');
  assert.equal(out.max_tokens, 100);
  assert.equal(out.messages[0].role, 'user');
  assert.match(out.messages[0].content, /Summary of the earlier conversation so far:\n\nTHE SUMMARY/);
  assert.equal(out.messages[1].role, 'assistant');
  assert.deepEqual(out.messages.slice(2), tail);
  // valid alternation: user, assistant, user, assistant
  assert.deepEqual(out.messages.map((m: any) => m.role), ['user', 'assistant', 'user', 'assistant']);
  // original body not mutated
  assert.deepEqual(body.messages, [{ role: 'user', content: 'orig' }]);
});
