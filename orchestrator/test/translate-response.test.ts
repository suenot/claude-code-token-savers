import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiToAnthropicResponse, normalizeToolUseId, parseToolArguments, mapFinishReason } from '../src/translate/response.ts';
import type { TranslateMeta } from '../src/translate/request.ts';

const meta = (map: Record<string, string> = {}): TranslateMeta => ({ toolNameMap: map, model: 'a8e/x', stream: false });

// --- B1: content order + tool_use --------------------------------------------

test('B1: content order thinking -> text -> tool_use', () => {
  const res = openaiToAnthropicResponse(
    {
      id: 'chatcmpl-1',
      model: 'a8e/x',
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            reasoning_content: 'hmm',
            content: 'here',
            tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a":1}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
    meta(),
  );
  assert.equal(res.content[0].type, 'thinking');
  assert.equal(res.content[1].type, 'text');
  assert.equal(res.content[2].type, 'tool_use');
  assert.deepEqual(res.content[2].input, { a: 1 });
});

test('B1: empty arguments parse to {}', () => {
  const res = openaiToAnthropicResponse(
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '' } }] } }], usage: {} },
    meta(),
  );
  assert.deepEqual(res.content[0].input, {});
});

test('B1: invalid-JSON arguments are bracket-repaired', () => {
  // truncated object missing its closing brace
  const res = openaiToAnthropicResponse(
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"location":"Paris"' } }] } }], usage: {} },
    meta(),
  );
  assert.deepEqual(res.content[0].input, { location: 'Paris' });
});

test('B1/D7: unrepairable / non-object input wraps as {rawInvalidInput}', () => {
  assert.deepEqual(parseToolArguments('not json at all'), { rawInvalidInput: 'not json at all' });
  assert.deepEqual(parseToolArguments('42'), { rawInvalidInput: 42 });
  assert.deepEqual(parseToolArguments('[1,2]'), { rawInvalidInput: [1, 2] });
});

// --- B2: id normalization + name restore -------------------------------------

test('B2: ids are normalized but passed through (not minted)', () => {
  assert.equal(normalizeToolUseId('call_abc-123'), 'call_abc-123');
  assert.equal(normalizeToolUseId('functions.Bash:0'), 'functions_Bash_0');
  assert.equal(normalizeToolUseId('id__thought__sig'), 'id');
  assert.equal(normalizeToolUseId('!!!'), '___');
  assert.equal(normalizeToolUseId(''), 'tool_use_id');
});

test('B2/D6: truncated tool name restored from meta map', () => {
  const long = 'b'.repeat(80);
  const truncated = 'b'.repeat(55) + '_deadbeef';
  const res = openaiToAnthropicResponse(
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: truncated, arguments: '{}' } }] } }], usage: {} },
    meta({ [truncated]: long }),
  );
  assert.equal(res.content[0].name, long);
});

test('B2: response id passed through', () => {
  const res = openaiToAnthropicResponse({ id: 'chatcmpl-xyz', choices: [{ finish_reason: 'stop', message: { content: 'hi' } }], usage: {} }, meta());
  assert.equal(res.id, 'chatcmpl-xyz');
});

// --- B3: finish_reason -------------------------------------------------------

test('B3: finish_reason matrix', () => {
  assert.equal(mapFinishReason('stop'), 'end_turn');
  assert.equal(mapFinishReason('length'), 'max_tokens');
  assert.equal(mapFinishReason('tool_calls'), 'tool_use');
  assert.equal(mapFinishReason('function_call'), 'tool_use');
  assert.equal(mapFinishReason('content_filter'), 'end_turn');
  assert.equal(mapFinishReason('anything_else'), 'end_turn');
});

// --- B4: usage ---------------------------------------------------------------

test('B4: usage mapping with cached_tokens', () => {
  const res = openaiToAnthropicResponse(
    {
      choices: [{ finish_reason: 'stop', message: { content: 'x' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
    },
    meta(),
  );
  assert.equal(res.usage.input_tokens, 70); // 100 - 30 cache_read
  assert.equal(res.usage.output_tokens, 20);
  assert.equal(res.usage.cache_read_input_tokens, 30);
});

test('B4: usage without cache omits cache fields', () => {
  const res = openaiToAnthropicResponse({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }, meta());
  assert.deepEqual(res.usage, { input_tokens: 5, output_tokens: 1 });
});

// --- envelope ----------------------------------------------------------------

test('response envelope shape', () => {
  const res = openaiToAnthropicResponse({ id: 'i', model: 'a8e/x', choices: [{ finish_reason: 'stop', message: { content: 'hello' } }], usage: {} }, meta());
  assert.equal(res.type, 'message');
  assert.equal(res.role, 'assistant');
  assert.equal(res.model, 'a8e/x');
  assert.equal(res.stop_reason, 'end_turn');
  assert.equal(res.stop_sequence, null);
  assert.deepEqual(res.content[0], { type: 'text', text: 'hello' });
});

test('empty assistant content omits the text block', () => {
  const res = openaiToAnthropicResponse({ choices: [{ finish_reason: 'stop', message: { content: '' } }], usage: {} }, meta());
  assert.equal(res.content.length, 0);
});
