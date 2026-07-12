import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crushText, crushBody } from '../src/crush/crush.ts';

// crushText operates against an explicit budget; crushBody gates on threshold.

test('strips ANSI escape codes', () => {
  const colored = 'error: [31mred text[0m and [1mbold[0m done';
  const out = crushText(colored, 100000);
  assert.equal(out, 'error: red text and bold done');
});

test('collapses runs of 3+ identical consecutive lines', () => {
  const text = ['head', 'dup', 'dup', 'dup', 'dup', 'tail'].join('\n');
  const out = crushText(text, 100000);
  assert.equal(out, ['head', 'dup', '… [3 more identical lines]', 'tail'].join('\n'));
});

test('a run of exactly 2 identical lines is left alone', () => {
  const text = ['a', 'dup', 'dup', 'b'].join('\n');
  assert.equal(crushText(text, 100000), text);
});

test('head/tail window with marker when still over budget', () => {
  // 400 distinct lines, no ANSI, no runs → only the head/tail pass can shrink it.
  const lines = Array.from({ length: 400 }, (_, i) => `line-${i}`);
  const text = lines.join('\n');
  const out = crushText(text, 2000);
  assert.ok(out.length < text.length);
  assert.match(out, /\n… \[crushed \d+ chars\] …\n/);
  // whole lines only — never cut mid-line
  assert.ok(out.startsWith('line-0\n'));
  assert.ok(out.endsWith('\nline-399'));
  for (const piece of out.split('\n')) {
    assert.ok(piece === '' || /^line-\d+$/.test(piece) || /^… \[crushed \d+ chars\] …$/.test(piece));
  }
});

test('crushText is idempotent (crush of crushed === crushed)', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line-${i}`);
  const text = lines.join('\n');
  const once = crushText(text, 2000);
  const twice = crushText(once, 2000);
  assert.equal(twice, once);
});

test('crushText is deterministic (two calls byte-identical)', () => {
  const text = Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n');
  assert.equal(crushText(text, 500), crushText(text, 500));
});

test('collapse then head/tail compose and stay idempotent', () => {
  const blanks = Array.from({ length: 500 }, () => '').join('\n');
  const text = 'START\n' + blanks + '\nMIDDLE\n' + 'x'.repeat(5000) + '\nEND';
  const once = crushText(text, 2000);
  assert.equal(crushText(once, 2000), once);
});

// ---- crushBody ----

const bigLog = Array.from({ length: 400 }, (_, i) => `log-${i}`).join('\n'); // > 2000 chars

test('crushBody crushes an over-threshold string tool_result', () => {
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigLog }] },
    ],
  };
  const { body, stats } = crushBody(input);
  assert.equal(stats.crushedBlocks, 1);
  assert.ok(stats.savedChars > 0);
  assert.ok(body.messages[0].content[0].content.length < bigLog.length);
  assert.match(body.messages[0].content[0].content, /… \[crushed \d+ chars\] …/);
});

test('crushBody crushes text blocks inside array-form tool_result', () => {
  const input = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', content: [{ type: 'text', text: bigLog }] },
        ],
      },
    ],
  };
  const { body, stats } = crushBody(input);
  assert.equal(stats.crushedBlocks, 1);
  assert.ok(body.messages[0].content[0].content[0].text.length < bigLog.length);
});

test('crushBody leaves at/below-threshold tool_result untouched', () => {
  const small = 'x'.repeat(1999);
  const input = { messages: [{ role: 'user', content: [{ type: 'tool_result', content: small }] }] };
  const { body, stats } = crushBody(input);
  assert.equal(stats.crushedBlocks, 0);
  assert.equal(body.messages[0].content[0].content, small);
});

test('crushBody never touches non-tool_result blocks', () => {
  const input = {
    system: bigLog,
    messages: [
      { role: 'user', content: [{ type: 'text', text: bigLog }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: bigLog }] },
    ],
  };
  const { body, stats } = crushBody(input);
  assert.equal(stats.crushedBlocks, 0);
  assert.equal(body.system, bigLog);
  assert.equal(body.messages[0].content[0].text, bigLog);
  assert.equal(body.messages[1].content[0].thinking, bigLog);
});

test('crushBody no-op returns the same body object by reference', () => {
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: bigLog }] }] };
  const { body } = crushBody(input);
  assert.equal(body, input); // structurally shared, unchanged
});

test('crushBody does not mutate its input', () => {
  const input = {
    messages: [{ role: 'user', content: [{ type: 'tool_result', content: bigLog }] }],
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  crushBody(input);
  assert.deepEqual(input, snapshot);
});

test('crushBody is idempotent (double-crush === single-crush)', () => {
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', content: bigLog }] },
      { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: bigLog }] }] },
    ],
  };
  const once = crushBody(input).body;
  const twice = crushBody(once).body;
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test('crushBody idempotent even when budget exceeds threshold', () => {
  // budget > threshold means the crushed output can still be over threshold, so
  // the second pass re-runs the pipeline — it must still be a no-op.
  const huge = Array.from({ length: 2000 }, (_, i) => `row-${i}`).join('\n');
  const input = { messages: [{ role: 'user', content: [{ type: 'tool_result', content: huge }] }] };
  const opts = { threshold: 2000, budget: 8000 };
  const once = crushBody(input, opts).body;
  const twice = crushBody(once, opts).body;
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test('crushBody handles bodies without messages', () => {
  const { body, stats } = crushBody({ model: 'x' });
  assert.deepEqual(body, { model: 'x' });
  assert.deepEqual(stats, { crushedBlocks: 0, savedChars: 0 });
});
