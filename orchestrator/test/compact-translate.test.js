import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAI, openAIMessageToAnthropic, anthropicSSEChunks } from '../src/compact/translate.js';

test('anthropicToOpenAI: string system + string message', () => {
  const r = anthropicToOpenAI(
    { system: 'sys', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64000, stream: true },
    'deepseek/deepseek-v4-flash',
  );
  assert.equal(r.model, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(r.messages[0], { role: 'system', content: 'sys' });
  assert.deepEqual(r.messages[1], { role: 'user', content: 'hi' });
  assert.equal(r.max_tokens, 32000); // capped
  assert.equal(r.temperature, 0);
  assert.equal(r.stream, true);
});

test('anthropicToOpenAI: system blocks + flattened tool blocks', () => {
  const r = anthropicToOpenAI({
    system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
    messages: [{ role: 'assistant', content: [
      { type: 'text', text: 'doing' },
      { type: 'tool_use', name: 'Read', input: { file: 'x' } },
    ] }, { role: 'user', content: [
      { type: 'tool_result', content: 'FILE BODY' },
      { type: 'image' },
    ] }],
  }, 'm');
  assert.equal(r.messages[0].content, 'AB');
  assert.match(r.messages[1].content, /doing/);
  assert.match(r.messages[1].content, /\[tool_call Read \{"file":"x"\}\]/);
  assert.match(r.messages[2].content, /\[tool_result FILE BODY\]/);
  assert.match(r.messages[2].content, /\[image omitted\]/);
  assert.equal(r.stream, false); // no stream flag → false
});

test('openAIMessageToAnthropic: correct message shape', () => {
  const m = openAIMessageToAnthropic('the summary', { model: 'm', inputTokens: 5, outputTokens: 7 });
  assert.equal(m.type, 'message');
  assert.equal(m.role, 'assistant');
  assert.equal(m.model, 'm');
  assert.deepEqual(m.content, [{ type: 'text', text: 'the summary' }]);
  assert.equal(m.stop_reason, 'end_turn');
  assert.deepEqual(m.usage, { input_tokens: 5, output_tokens: 7 });
});

test('anthropicSSEChunks: ordered frames carrying the text', () => {
  const frames = anthropicSSEChunks('hello', { model: 'm' });
  const types = frames.map((f) => f.match(/^event: (\S+)/)[1]);
  assert.deepEqual(types, [
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.match(frames[2], /"text_delta"/);
  assert.match(frames[2], /hello/);
  for (const f of frames) assert.match(f, /^event: \S+\ndata: .+\n\n$/s);
});

test('anthropicToOpenAI: max_tokens default and under-cap passthrough', () => {
  assert.equal(anthropicToOpenAI({ messages: [] }, 'm').max_tokens, 8192); // default
  assert.equal(anthropicToOpenAI({ messages: [], max_tokens: 5000 }, 'm').max_tokens, 5000); // under cap unchanged
});
