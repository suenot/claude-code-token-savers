import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAIRequest, truncateToolName } from '../src/translate/request.ts';

// --- A2: tools ---------------------------------------------------------------

test('A2: tools translate to OpenAI function shape; description/params handled', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [],
    tools: [
      { name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'noschema' },
    ],
  });
  assert.equal(body.tools.length, 2);
  assert.deepEqual(body.tools[0], {
    type: 'function',
    function: { name: 'get_weather', parameters: { type: 'object', properties: { q: { type: 'string' } } }, description: 'weather' },
  });
  // input_schema absent -> no parameters; description absent -> no description.
  assert.deepEqual(body.tools[1], { type: 'function', function: { name: 'noschema' } });
});

test('A2: Anthropic tool `type` is NOT merged into parameters (D5)', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [],
    tools: [{ name: 't', type: 'custom', input_schema: { type: 'object', properties: {} } }],
  });
  assert.equal(body.tools[0].function.parameters.type, 'object');
});

test('A2/D9: empty tools array is omitted (undefined, not [])', () => {
  const { body } = anthropicToOpenAIRequest({ model: 'a8e/x', messages: [], tools: [] });
  assert.equal('tools' in body, false);
});

test('A2: blank/missing tool name synthesizes unnamed_tool_{idx}', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [],
    tools: [{ input_schema: { type: 'object' } }, { name: '   ' }],
  });
  assert.equal(body.tools[0].function.name, 'unnamed_tool_0');
  assert.equal(body.tools[1].function.name, 'unnamed_tool_1');
});

test('D6: tool name >64 chars truncates and records the restore map in meta', () => {
  const long = 'a'.repeat(80);
  const { body, meta } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [],
    tools: [{ name: long, input_schema: { type: 'object' } }],
  });
  const truncated = body.tools[0].function.name;
  assert.equal(truncated.length, 64);
  assert.equal(truncateToolName(long), truncated);
  assert.equal(meta.toolNameMap[truncated], long);
});

// --- A3: tool_choice ---------------------------------------------------------

test('A3: tool_choice matrix', () => {
  const mk = (tc: any) => anthropicToOpenAIRequest({ model: 'a8e/x', messages: [], tool_choice: tc }).body.tool_choice;
  assert.equal(mk({ type: 'auto' }), 'auto');
  assert.equal(mk({ type: 'any' }), 'required');
  assert.equal(mk({ type: 'none' }), 'none');
  assert.deepEqual(mk({ type: 'tool', name: 'f' }), { type: 'function', function: { name: 'f' } });
});

test('A3: disable_parallel_tool_use -> top-level parallel_tool_calls:false', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  });
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tool_choice, 'auto');
});

// --- A4: assistant tool_use history ------------------------------------------

test('A4: assistant tool_use -> tool_calls with JSON-string arguments', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'Paris' } },
        ],
      },
    ],
  });
  const msg = body.messages[0];
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, 'let me check');
  assert.equal(msg.tool_calls.length, 1);
  assert.deepEqual(msg.tool_calls[0], {
    id: 'call_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"location":"Paris"}' },
  });
});

test('A4: assistant with only tool_use -> content null, tool_calls set', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: {} }] }],
  });
  assert.equal(body.messages[0].content, null);
  assert.equal(body.messages[0].tool_calls.length, 1);
});

// --- A5: user tool_result ----------------------------------------------------

test('A5: tool_use_id -> tool_call_id on a role:tool message', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] }],
  });
  assert.deepEqual(body.messages[0], { role: 'tool', tool_call_id: 'call_1', content: 'ok' });
});

test('A5/D11: multiple tool_results in one user msg -> separate role:tool msgs', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'ra' },
          { type: 'tool_result', tool_use_id: 'b', content: 'rb' },
        ],
      },
    ],
  });
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].tool_call_id, 'a');
  assert.equal(body.messages[1].tool_call_id, 'b');
});

test('A5/D11: one multi-part tool_result stays ONE tool msg with array content', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].tool_call_id, 'a');
  assert.equal(Array.isArray(body.messages[0].content), true);
  assert.deepEqual(body.messages[0].content[0], { type: 'text', text: 'see' });
  assert.equal(body.messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('A5: tool_result content shapes — absent, single text block, single string', () => {
  const mk = (c: any) =>
    anthropicToOpenAIRequest({
      model: 'a8e/x',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', ...(c === undefined ? {} : { content: c }) }] }],
    }).body.messages[0].content;
  assert.equal(mk(undefined), '');
  assert.equal(mk([{ type: 'text', text: 'flat' }]), 'flat');
  assert.equal(mk(['just a string']), 'just a string');
});

test('A5: is_error folds a marker into the tool content', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'boom' }] }],
  });
  assert.match(body.messages[0].content, /tool_error/);
  assert.match(body.messages[0].content, /boom/);
});

test('A5: tool results emitted BEFORE residual user text', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'r' },
          { type: 'text', text: 'and also this' },
        ],
      },
    ],
  });
  assert.equal(body.messages[0].role, 'tool');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, 'and also this');
});

test('mixed text+tool_use assistant turn emits both', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }, { type: 'tool_use', id: 'c', name: 'f', input: { a: 1 } }] },
    ],
  });
  assert.equal(body.messages[0].content, 'AB');
  assert.equal(body.messages[0].tool_calls.length, 1);
});

// --- A6: system --------------------------------------------------------------

test('A6: string system -> one system msg at index 0', () => {
  const { body } = anthropicToOpenAIRequest({ model: 'a8e/x', system: 'be nice', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(body.messages[0], { role: 'system', content: 'be nice' });
  assert.equal(body.messages[1].role, 'user');
});

test('A6: array system -> system msg with array content', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    system: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
    messages: [],
  });
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]);
});

// --- A7: housekeeping --------------------------------------------------------

test('A7/D13: cache_control is stripped for plain OpenAI targets', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [{ name: 't', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
  });
  const json = JSON.stringify(body);
  assert.equal(json.includes('cache_control'), false);
});

test('A7: base64 and url images wrap as image_url', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZZZ' } },
          { type: 'image', source: { type: 'url', url: 'https://ex/img.png' } },
        ],
      },
    ],
  });
  const parts = body.messages[0].content;
  assert.equal(parts[0].image_url.url, 'data:image/jpeg;base64,ZZZ');
  assert.equal(parts[1].image_url.url, 'https://ex/img.png');
});

// --- A1: top-level -----------------------------------------------------------

test('A1: copy-through, metadata.user_id -> user, stop_sequences -> stop', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [],
    max_tokens: 500,
    temperature: 0.3,
    stream: true,
    stop_sequences: ['STOP'],
    metadata: { user_id: 'u42' },
  });
  assert.equal(body.max_tokens, 500);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.stream, true);
  assert.equal(body.user, 'u42');
  assert.deepEqual(body.stop, ['STOP']);
  assert.equal('stop_sequences' in body, false);
  assert.equal('metadata' in body, false);
});

test('A1: thinking -> reasoning_effort (bucketed) for non-Claude; disabled dropped', () => {
  const mk = (thinking: any) => anthropicToOpenAIRequest({ model: 'a8e/x', messages: [], thinking }).body;
  assert.equal(mk({ type: 'enabled', budget_tokens: 5000 }).reasoning_effort, 'high');
  assert.equal(mk({ type: 'enabled', budget_tokens: 2500 }).reasoning_effort, 'medium');
  assert.equal(mk({ type: 'enabled', budget_tokens: 1500 }).reasoning_effort, 'low');
  assert.equal(mk({ type: 'enabled', budget_tokens: 100 }).reasoning_effort, 'minimal');
  assert.equal('reasoning_effort' in mk({ type: 'disabled' }), false);
  assert.equal('thinking' in mk({ type: 'disabled' }), false);
});

test('A1: thinking stays native for a Claude target', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'anthropic/claude-opus-4-8',
    messages: [],
    thinking: { type: 'enabled', budget_tokens: 2000 },
  });
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2000 });
  assert.equal('reasoning_effort' in body, false);
});

test('A2: output_format -> response_format with strict recursion', () => {
  const { body } = anthropicToOpenAIRequest({
    model: 'a8e/x',
    messages: [],
    output_format: {
      type: 'json_schema',
      schema: { type: 'object', properties: { name: { type: 'string' }, nested: { type: 'object', properties: { z: { type: 'number' } } } } },
    },
  });
  const rf = body.response_format;
  assert.equal(rf.type, 'json_schema');
  assert.equal(rf.json_schema.strict, true);
  assert.equal(rf.json_schema.schema.additionalProperties, false);
  assert.deepEqual(rf.json_schema.schema.required, ['name', 'nested']);
  assert.equal(rf.json_schema.schema.properties.nested.additionalProperties, false);
});

test('meta reports stream flag and model', () => {
  const { meta } = anthropicToOpenAIRequest({ model: 'a8e/y', messages: [], stream: true });
  assert.equal(meta.stream, true);
  assert.equal(meta.model, 'a8e/y');
});
