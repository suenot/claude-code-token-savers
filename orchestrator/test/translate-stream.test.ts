import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIToAnthropicStream } from '../src/translate/stream.ts';
import type { TranslateMeta } from '../src/translate/request.ts';

const meta = (map: Record<string, string> = {}): TranslateMeta => ({ toolNameMap: map, model: 'a8e/x', stream: true });

// Serialize OpenAI chunk objects as SSE, feed them through the translator, and
// parse the emitted Anthropic SSE back into event objects. `chunks` are OpenAI
// chunk objects; the string '[DONE]' stands for the terminal SSE sentinel.
function run(chunks: any[], m: TranslateMeta = meta()): any[] {
  const stream = createOpenAIToAnthropicStream(m);
  const out: string[] = [];
  for (const c of chunks) {
    const line = c === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(c)}\n\n`;
    out.push(...stream.write(line));
  }
  out.push(...stream.end());
  return parseEvents(out);
}

function parseEvents(frames: string[]): any[] {
  const events: any[] = [];
  for (const f of frames) {
    // Wire format C5: `event: <type>\ndata: <json>\n\n`
    const m = f.match(/^event: (.+)\ndata: (.+)\n\n$/s);
    assert.ok(m, `frame not in wire format: ${JSON.stringify(f)}`);
    const [, type, json] = m!;
    const obj = JSON.parse(json);
    assert.equal(obj.type, type, 'event name must equal JSON type (C5)');
    events.push(obj);
  }
  return events;
}

const types = (events: any[]) => events.map((e) => e.type);

// OpenAI chunk builders.
const roleChunk = () => ({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
const textChunk = (t: string) => ({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const toolOpen = (index: number, id: string, name: string) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }],
});
const toolArgs = (index: number, args: string) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args } }] }, finish_reason: null }],
});
const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = (usage: any) => ({ choices: [], usage });

// --- single tool call streamed in fragments ----------------------------------

test('single tool call in fragments: clean start/delta*/stop/message_delta/stop', () => {
  const events = run([
    roleChunk(),
    toolOpen(0, 'call_abc', 'get_weather'),
    toolArgs(0, '{"location":'),
    toolArgs(0, '"Paris"}'),
    finish('tool_calls'),
    usageChunk({ prompt_tokens: 10, completion_tokens: 5 }),
    '[DONE]',
  ]);
  assert.deepEqual(types(events), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  const start = events[1];
  assert.equal(start.index, 0);
  assert.deepEqual(start.content_block, { type: 'tool_use', id: 'call_abc', name: 'get_weather', input: {} });
  // Raw partial_json passthrough, concatenatable to valid JSON (C3/D4).
  const joined = events[2].delta.partial_json + events[3].delta.partial_json;
  assert.deepEqual(JSON.parse(joined), { location: 'Paris' });
  // message_delta carries the merged trailing usage (C4).
  assert.equal(events[5].delta.stop_reason, 'tool_use');
  assert.deepEqual(events[5].usage, { input_tokens: 10, output_tokens: 5 });
});

// --- two parallel tool calls interleaved by index ----------------------------

test('two parallel tool calls at index 0 and 1', () => {
  const events = run([
    roleChunk(),
    toolOpen(0, 'c1', 'a'),
    toolArgs(0, '{"x":1}'),
    toolOpen(1, 'c2', 'b'),
    toolArgs(1, '{"y":2}'),
    finish('tool_calls'),
    usageChunk({ prompt_tokens: 1, completion_tokens: 1 }),
    '[DONE]',
  ]);
  assert.deepEqual(types(events), [
    'message_start',
    'content_block_start', // tool a @0
    'content_block_delta',
    'content_block_stop', // close @0
    'content_block_start', // tool b @1
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.equal(events[1].content_block.name, 'a');
  assert.equal(events[1].index, 0);
  assert.equal(events[4].content_block.name, 'b');
  assert.equal(events[4].index, 1);
});

// --- text -> tool -> text transitions with trigger re-emit -------------------

test('text -> tool -> text: each new block first token present exactly once', () => {
  const events = run([
    roleChunk(),
    textChunk('Hello'),
    textChunk(' world'),
    toolOpen(0, 'c1', 'f'),
    toolArgs(0, '{}'),
    textChunk('Done'),
    finish('stop'),
    usageChunk({ prompt_tokens: 2, completion_tokens: 2 }),
    '[DONE]',
  ]);
  assert.deepEqual(types(events), [
    'message_start',
    'content_block_start', // text @0
    'content_block_delta', // "Hello"
    'content_block_delta', // " world"
    'content_block_stop', // close text @0
    'content_block_start', // tool @1
    'content_block_delta', // "{}"
    'content_block_stop', // close tool @1
    'content_block_start', // text @2
    'content_block_delta', // "Done" re-emitted
    'content_block_stop', // close text @2
    'message_delta',
    'message_stop',
  ]);
  // The first token of the reborn text block is present exactly once.
  const doneDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta.type === 'text_delta' && e.delta.text === 'Done');
  assert.equal(doneDeltas.length, 1);
  assert.equal(doneDeltas[0].index, 2);
  // "Hello" is the first token of the first text block, present exactly once.
  const helloDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta.text === 'Hello');
  assert.equal(helloDeltas.length, 1);
  assert.equal(helloDeltas[0].index, 0);
});

// --- empty-args tool: start then stop, zero deltas ---------------------------

test('empty-args tool: start then stop with zero deltas', () => {
  const events = run([
    roleChunk(),
    toolOpen(0, 'c1', 'noargs'),
    finish('tool_calls'),
    usageChunk({ prompt_tokens: 1, completion_tokens: 0 }),
    '[DONE]',
  ]);
  assert.deepEqual(types(events), ['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop']);
});

// --- message_start seed usage ------------------------------------------------

test('message_start carries zeroed usage incl cache fields (C2)', () => {
  const events = run([roleChunk(), textChunk('hi'), finish('stop'), usageChunk({ prompt_tokens: 1, completion_tokens: 1 }), '[DONE]']);
  assert.deepEqual(events[0].message.usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  assert.equal(events[0].message.model, 'a8e/x');
});

// --- trailing usage merge ----------------------------------------------------

test('trailing usage chunk merged into held message_delta (C4)', () => {
  const events = run([roleChunk(), textChunk('x'), finish('stop'), usageChunk({ prompt_tokens: 7, completion_tokens: 3 }), '[DONE]']);
  const md = events.find((e) => e.type === 'message_delta');
  assert.deepEqual(md.usage, { input_tokens: 7, output_tokens: 3 });
  // message_delta appears exactly once and message_stop is last.
  assert.equal(events.filter((e) => e.type === 'message_delta').length, 1);
  assert.equal(events[events.length - 1].type, 'message_stop');
});

test('finish with no trailing usage chunk: held message_delta flushed at end', () => {
  const events = run([roleChunk(), textChunk('x'), finish('stop')]);
  assert.deepEqual(types(events), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events.find((e) => e.type === 'message_delta').delta.stop_reason, 'end_turn');
});

// --- collapsed content+finish chunk ------------------------------------------

test('collapsed content+finish chunk is split (C4)', () => {
  const events = run([
    { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    '[DONE]',
  ]);
  assert.deepEqual(types(events), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events[2].delta.text, 'Hi');
  assert.equal(events.find((e) => e.type === 'message_delta').usage.output_tokens, 1);
});

// --- no events after message_delta (D10) -------------------------------------

test('stragglers after the final message_delta are dropped (D10)', () => {
  const events = run([
    roleChunk(),
    textChunk('x'),
    finish('stop'),
    usageChunk({ prompt_tokens: 1, completion_tokens: 1 }), // merged -> final message_delta emitted
    textChunk('SHOULD BE DROPPED'),
    '[DONE]',
  ]);
  // Nothing between message_delta and message_stop.
  const mdIdx = events.findIndex((e) => e.type === 'message_delta');
  assert.equal(events[mdIdx + 1].type, 'message_stop');
  assert.equal(events.length, mdIdx + 2);
  assert.equal(events.some((e) => e.type === 'content_block_delta' && e.delta.text === 'SHOULD BE DROPPED'), false);
});

// --- tool name restore in stream ---------------------------------------------

test('D6: streamed tool name restored from meta map', () => {
  const long = 'z'.repeat(80);
  const truncated = 'z'.repeat(55) + '_cafebabe';
  const events = run(
    [roleChunk(), toolOpen(0, 'c1', truncated), toolArgs(0, '{}'), finish('tool_calls'), usageChunk({ prompt_tokens: 1, completion_tokens: 1 }), '[DONE]'],
    meta({ [truncated]: long }),
  );
  assert.equal(events[1].content_block.name, long);
});

// --- fragmentation across write() boundaries ---------------------------------

test('SSE split mid-line across write() calls is reassembled', () => {
  const stream = createOpenAIToAnthropicStream(meta());
  const full = `data: ${JSON.stringify(textChunk('hello'))}\n\n`;
  const out: string[] = [];
  out.push(...stream.write('data: ' + JSON.stringify(roleChunk()) + '\n\n' + full.slice(0, 10)));
  out.push(...stream.write(full.slice(10)));
  out.push(...stream.write(`data: ${JSON.stringify(finish('stop'))}\n\n`));
  out.push(...stream.end());
  const events = parseEvents(out);
  const textDelta = events.find((e) => e.type === 'content_block_delta');
  assert.equal(textDelta.delta.text, 'hello');
});
