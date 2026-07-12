import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupBody } from '../src/dedup/blocks.ts';

const big = 'A'.repeat(300); // >= MIN_BLOCK_CHARS (200)
const big2 = 'B'.repeat(300);
const marker = (n: number) => `[shuba-dedup: identical to block #${n} above]`;

test('no messages → unchanged, zero stats', () => {
  const { body, stats } = dedupBody({ model: 'x' });
  assert.deepEqual(body, { model: 'x' });
  assert.deepEqual(stats, { dupBlocks: 0, savedChars: 0 });
});

test('all-unique large blocks are untouched', () => {
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'user', content: [{ type: 'text', text: big2 }] },
    ],
  };
  const { body, stats } = dedupBody(input);
  assert.equal(stats.dupBlocks, 0);
  assert.equal(body.messages[0].content[0].text, big);
  assert.equal(body.messages[1].content[0].text, big2);
});

test('three identical large blocks: first kept, 2nd+ replaced with marker #1', () => {
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'user', content: [{ type: 'text', text: big }] },
    ],
  };
  const { body, stats } = dedupBody(input);
  assert.equal(stats.dupBlocks, 2);
  assert.equal(body.messages[0].content[0].text, big); // first verbatim
  assert.equal(body.messages[1].content[0].text, marker(1));
  assert.equal(body.messages[2].content[0].text, marker(1));
  assert.equal(stats.savedChars, 2 * (big.length - marker(1).length));
});

test('below-gate identical small block is left untouched', () => {
  const small = 'C'.repeat(50); // < 200
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: big }, { type: 'text', text: small }] },
      { role: 'user', content: [{ type: 'text', text: big }, { type: 'text', text: small }] },
    ],
  };
  const { body, stats } = dedupBody(input);
  // only the big block dedups; both small copies survive verbatim
  assert.equal(stats.dupBlocks, 1);
  assert.equal(body.messages[1].content[0].text, marker(1));
  assert.equal(body.messages[0].content[1].text, small);
  assert.equal(body.messages[1].content[1].text, small);
});

test('text and tool_result with same string are not merged across types', () => {
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'user', content: [{ type: 'tool_result', content: big }] },
    ],
  };
  const { body, stats } = dedupBody(input);
  assert.equal(stats.dupBlocks, 0);
  assert.equal(body.messages[0].content[0].text, big);
  assert.equal(body.messages[1].content[0].content, big);
});

test('duplicate tool_result blocks dedup (stringified content)', () => {
  const payload = { file: 'x'.repeat(300) };
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', content: payload }] },
      { role: 'user', content: [{ type: 'tool_result', content: payload }] },
    ],
  };
  const { body, stats } = dedupBody(input);
  assert.equal(stats.dupBlocks, 1);
  assert.deepEqual(body.messages[0].content[0].content, payload);
  assert.equal(body.messages[1].content[0].text, marker(1));
});

test('string-form message content is never touched', () => {
  const input = {
    messages: [
      { role: 'user', content: big },
      { role: 'user', content: big },
    ],
  };
  const { body, stats } = dedupBody(input);
  assert.equal(stats.dupBlocks, 0);
  assert.equal(body.messages[0].content, big);
  assert.equal(body.messages[1].content, big);
});

test('input body is not mutated', () => {
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: big }] },
      { role: 'user', content: [{ type: 'text', text: big }] },
    ],
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  const { body } = dedupBody(input);
  assert.deepEqual(input, snapshot); // original untouched
  assert.notEqual(body.messages[1].content[0].text, big); // returned copy changed
});
