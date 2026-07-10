# compact-interceptor (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A built-in shuba stage that intercepts Claude Code's `/compact` request (fingerprint: last user turn contains "create a detailed summary of the conversation so far") and serves it from a cheap model (deepseek-v4-flash via OpenRouter), passing everything else through and falling back to the flagship on any error.

**Architecture:** Pure `matcher` + pure `translate` (Anthropic⇄OpenAI, incl. streaming SSE) + an HTTP `server` that intercepts matched requests and passes the rest through; wired into shuba as a `compact-router` builtin registry stage. Node built-ins only.

**Tech Stack:** Node ≥18 (ESM, `node:test`, global `fetch`, `node:http`, `node:stream`). No runtime deps. Develop in `orchestrator/` (shuba dev copy).

## Global Constraints

- Node ≥18, ESM (`"type":"module"`), NO runtime npm deps, dev/test Node built-ins only.
- Files live under `orchestrator/`. Match existing shuba style (see `src/registry.js`, `src/planner.js`, `src/supervisor.js`).
- Fingerprint (verbatim, case-insensitive substring of the last user turn's text): `create a detailed summary of the conversation so far`.
- Default compact model `deepseek/deepseek-v4-flash`; default base URL `https://openrouter.ai/api/v1`; default env key `OPENROUTER_API_KEY`.
- Passthrough MUST strip `content-encoding`, `content-length`, `transfer-encoding` from the upstream response and pipe the body stream (fetch already decodes encoding — re-advertising it corrupts the client, as seen with the ZlibError during fingerprint capture).
- On any external-model failure (network, non-2xx, empty content), the interceptor MUST fall back to transparent passthrough — `/compact` must never break.
- `compact-router` is a builtin stage: `bin` = `process.execPath` (node), `args` = `[<abs path to bin/compact-interceptor.js>]`; non-terminal; health `/health`.

---

## File Structure

```
orchestrator/
  bin/compact-interceptor.js        # entry: reads env, starts server
  src/compact/matcher.js            # isCompactRequest(body)
  src/compact/translate.js          # anthropicToOpenAI, openAIMessageToAnthropic, anthropicSSEChunks
  src/compact/server.js             # createInterceptor({...}) -> http.Server
  src/registry.js                   # + compact-router descriptor (MODIFY)
  src/planner.js                    # pass `config` into descriptor.build() (MODIFY)
  test/compact-matcher.test.js
  test/compact-translate.test.js
  test/compact-server.test.js
  test/registry.test.js             # + compact-router assertions (MODIFY)
  README.md                         # + compact-router section (MODIFY)
```

---

## Task 1: matcher (pure)

**Files:**
- Create: `orchestrator/src/compact/matcher.js`
- Test: `orchestrator/test/compact-matcher.test.js`

**Interfaces:**
- Produces: `isCompactRequest(body): boolean` — true iff the last `role:'user'` message's text contains the fingerprint (case-insensitive). Text = the message's `content` if it's a string, else the concatenation of `.text` from its content blocks.

- [ ] **Step 1: Write the failing test**

`orchestrator/test/compact-matcher.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCompactRequest } from '../src/compact/matcher.js';

const compactUser =
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
  'Your task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests.';

test('matches a real compact request (string content)', () => {
  const body = { messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: compactUser },
  ] };
  assert.equal(isCompactRequest(body), true);
});

test('matches when last user content is blocks', () => {
  const body = { messages: [
    { role: 'user', content: [{ type: 'text', text: compactUser }] },
  ] };
  assert.equal(isCompactRequest(body), true);
});

test('does not match a normal user turn', () => {
  const body = { messages: [{ role: 'user', content: 'summarize this file for me' }] };
  assert.equal(isCompactRequest(body), false);
});

test('ignores the fingerprint in an assistant turn (must be last USER turn)', () => {
  const body = { messages: [
    { role: 'assistant', content: compactUser },
    { role: 'user', content: 'ok thanks' },
  ] };
  assert.equal(isCompactRequest(body), false);
});

test('handles empty/malformed bodies', () => {
  assert.equal(isCompactRequest({}), false);
  assert.equal(isCompactRequest({ messages: [] }), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/compact-matcher.test.js`
Expected: FAIL — `Cannot find module '../src/compact/matcher.js'`

- [ ] **Step 3: Implement matcher.js**

`orchestrator/src/compact/matcher.js`:
```js
const FINGERPRINT = 'create a detailed summary of the conversation so far';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.text) || '').join('');
  return '';
}

export function isCompactRequest(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') {
      return textOf(messages[i].content).toLowerCase().includes(FINGERPRINT);
    }
  }
  return false;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && node --test test/compact-matcher.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/compact/matcher.js orchestrator/test/compact-matcher.test.js
git commit -m "feat(compact): request fingerprint matcher"
```

---

## Task 2: translate (pure)

**Files:**
- Create: `orchestrator/src/compact/translate.js`
- Test: `orchestrator/test/compact-translate.test.js`

**Interfaces:**
- `anthropicToOpenAI(body, model): { model, messages, max_tokens, temperature, stream }` — `system` (string or text-block array) becomes a leading `{role:'system'}` message; each message's content is flattened to a string (text blocks concatenated; `tool_use`→`[tool_call name {json}]`, `tool_result`→`[tool_result …]`, `image`→`[image omitted]`); `max_tokens = min(body.max_tokens ?? 8192, 16000)`, `temperature: 0`, `stream: !!body.stream`.
- `openAIMessageToAnthropic(text, { model, inputTokens = 0, outputTokens = 0 }): AnthropicMessage` — the non-streaming Anthropic `message` response shape.
- `anthropicSSEChunks(text, { model }): string[]` — ordered SSE frames (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`), each `event: <type>\ndata: <json>\n\n`.

- [ ] **Step 1: Write the failing test**

`orchestrator/test/compact-translate.test.js`:
```js
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
  assert.equal(r.max_tokens, 16000); // capped
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
  for (const f of frames) assert.match(f, /\n\ndata: .*\n\n$/s);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/compact-translate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement translate.js**

`orchestrator/src/compact/translate.js`:
```js
function flatten(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b) return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool_use') return `\n[tool_call ${b.name} ${JSON.stringify(b.input ?? {})}]`;
    if (b.type === 'tool_result') {
      const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      return `\n[tool_result ${c}]`;
    }
    if (b.type === 'image') return '\n[image omitted]';
    return '';
  }).join('');
}

export function anthropicToOpenAI(body, model) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: flatten(body.system) });
  for (const m of body.messages || []) {
    messages.push({ role: m.role, content: flatten(m.content) });
  }
  return {
    model,
    messages,
    max_tokens: Math.min(body.max_tokens ?? 8192, 16000),
    temperature: 0,
    stream: !!body.stream,
  };
}

export function openAIMessageToAnthropic(text, { model, inputTokens = 0, outputTokens = 0 }) {
  return {
    id: 'msg_compact',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function frame(type, obj) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
}

export function anthropicSSEChunks(text, { model }) {
  return [
    frame('message_start', { message: { id: 'msg_compact', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }),
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    frame('content_block_stop', { index: 0 }),
    frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }),
    frame('message_stop', {}),
  ];
}
```

Note: `frame` spreads `{type, ...obj}` so each `data:` payload includes its own `type` (Anthropic SSE requires it), and the `event:` line matches. The test's regex `/\n\ndata: .*\n\n$/s` holds because every frame is `event: X\ndata: {…}\n\n`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && node --test test/compact-translate.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/compact/translate.js orchestrator/test/compact-translate.test.js
git commit -m "feat(compact): Anthropic<->OpenAI translation incl. SSE frames"
```

---

## Task 3: server + bin entry

**Files:**
- Create: `orchestrator/src/compact/server.js`
- Create: `orchestrator/bin/compact-interceptor.js`
- Test: `orchestrator/test/compact-server.test.js`

**Interfaces:**
- Consumes: `isCompactRequest` (Task 1), `anthropicToOpenAI`/`openAIMessageToAnthropic`/`anthropicSSEChunks` (Task 2).
- Produces: `createInterceptor({ port, upstream, model, baseUrl, apiKey, fetchImpl = fetch }): http.Server` — a server that:
  - `GET /health` → 200 `{"status":"ok"}`.
  - `POST` to a `/v1/messages` path (not `count_tokens`): if `isCompactRequest(body)`, call `${baseUrl}/chat/completions` (Bearer `apiKey`, non-streaming) with `anthropicToOpenAI(body, model)`; on success return an Anthropic response (SSE frames if `body.stream`, else the message JSON); on ANY failure, fall back to passthrough to `upstream`.
  - everything else: transparent passthrough to `upstream`.
- The test starts the server on an ephemeral port and drives it with a real local `fetch`, injecting `fetchImpl` for the OUTBOUND calls (external model + upstream), routed by URL.

- [ ] **Step 1: Write the failing test**

`orchestrator/test/compact-server.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createInterceptor } from '../src/compact/server.js';

const compactBody = (stream) => ({
  model: 'claude-opus-4-8', max_tokens: 64000, stream,
  messages: [{ role: 'user', content: 'Your task is to create a detailed summary of the conversation so far.' }],
});

async function withServer(fetchImpl, fn) {
  const srv = createInterceptor({
    port: 0, upstream: 'https://upstream.test', model: 'deepseek/deepseek-v4-flash',
    baseUrl: 'https://ext.test/v1', apiKey: 'k', fetchImpl,
  });
  srv.listen(0);
  await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(base); } finally { srv.close(); }
}

test('health returns ok', async () => {
  await withServer(async () => ({ ok: true }), async (base) => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
  });
});

test('compact request (non-stream) is served by the external model', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.includes('ext.test')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'CHEAP SUMMARY' } }] }) };
    }
    throw new Error('upstream should not be called');
  };
  await withServer(fetchImpl, async (base) => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(compactBody(false)),
    });
    const j = await r.json();
    assert.equal(j.type, 'message');
    assert.equal(j.content[0].text, 'CHEAP SUMMARY');
    assert.ok(calls.some((u) => u.includes('ext.test/v1/chat/completions')));
  });
});

test('external failure falls back to upstream passthrough', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('ext.test')) throw new Error('model down');
    // upstream passthrough
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: null };
  };
  await withServer(fetchImpl, async (base) => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(compactBody(false)),
    });
    assert.equal(r.status, 200);
    assert.ok(calls.some((u) => u.includes('ext.test')), 'tried external first');
    assert.ok(calls.some((u) => u.includes('upstream.test/v1/messages')), 'fell back to upstream');
  });
});

test('non-compact request passes through to upstream', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer(fetchImpl, async (base) => {
    await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'normal question' }] }),
    });
    assert.ok(calls.every((u) => u.includes('upstream.test')), 'only upstream called');
    assert.ok(!calls.some((u) => u.includes('ext.test')), 'external never called');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/compact-server.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement server.js**

`orchestrator/src/compact/server.js`:
```js
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from './matcher.js';
import { anthropicToOpenAI, openAIMessageToAnthropic, anthropicSSEChunks } from './translate.js';

export function createInterceptor({ port, upstream, model, baseUrl, apiKey, fetchImpl = fetch }) {
  const log = (...a) => process.stderr.write(`[compact-router] ${a.join(' ')}\n`);

  async function passthrough(req, raw, res) {
    const headers = { ...req.headers };
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, { method: req.method, headers, body: raw.length ? raw : undefined });
    const out = Object.fromEntries((up.headers && up.headers.entries) ? up.headers.entries() : []);
    delete out['content-encoding']; delete out['content-length']; delete out['transfer-encoding'];
    res.writeHead(up.status || 200, out);
    if (up.body) Readable.fromWeb(up.body).pipe(res);
    else res.end();
  }

  async function serveCompact(body, res) {
    const oreq = anthropicToOpenAI(body, model);
    const r = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...oreq, stream: false }),
    });
    if (!r.ok) throw new Error(`external ${r.status}`);
    const data = await r.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('empty external content');
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const f of anthropicSSEChunks(text, { model })) res.write(f);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(openAIMessageToAnthropic(text, { model })));
    }
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const isMessages = req.method === 'POST' && req.url.includes('/v1/messages') && !req.url.includes('count_tokens');
      let body = null;
      if (isMessages) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
      try {
        if (body && isCompactRequest(body)) {
          try {
            await serveCompact(body, res);
            log('intercepted', model);
            return;
          } catch (e) {
            log('fallback', e.message);
            await passthrough(req, raw, res);
            return;
          }
        }
        await passthrough(req, raw, res);
      } catch (e) {
        if (!res.headersSent) res.writeHead(502);
        res.end('compact-router error: ' + e.message);
      }
    });
  });
  server.listen(port);
  return server;
}
```

Note: `serveCompact` writes the response; if it throws BEFORE `res.writeHead`, the catch falls back to passthrough. Because `serveCompact` only calls `res.writeHead` after the external call succeeds and returns text, a failure (throw) always happens before any bytes are sent — so fallback is safe.

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && node --test test/compact-server.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the bin entry**

`orchestrator/bin/compact-interceptor.js`:
```js
#!/usr/bin/env node
import { createInterceptor } from '../src/compact/server.js';

const port = Number(process.env.PORT || 47850);
const upstream = process.env.COMPACT_UPSTREAM || 'https://api.anthropic.com';
const model = process.env.COMPACT_MODEL || 'deepseek/deepseek-v4-flash';
const baseUrl = process.env.COMPACT_BASE_URL || 'https://openrouter.ai/api/v1';
const envKey = process.env.COMPACT_ENV_KEY || 'OPENROUTER_API_KEY';
const apiKey = process.env[envKey];
if (!apiKey) {
  process.stderr.write(`[compact-router] missing API key: set ${envKey}\n`);
  process.exit(1);
}
createInterceptor({ port, upstream, model, baseUrl, apiKey });
process.stderr.write(`[compact-router] listening on 127.0.0.1:${port} → ${upstream} (compact→${model})\n`);
```

- [ ] **Step 6: Verify the bin imports and reports the missing-key path**

Run: `cd orchestrator && env -u OPENROUTER_API_KEY COMPACT_ENV_KEY=OPENROUTER_API_KEY node bin/compact-interceptor.js; echo "exit=$?"`
Expected: prints `[compact-router] missing API key: set OPENROUTER_API_KEY` and `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/compact/server.js orchestrator/bin/compact-interceptor.js orchestrator/test/compact-server.test.js
git commit -m "feat(compact): interceptor server + bin entry (fallback-safe)"
```

---

## Task 4: register `compact-router` as a builtin shuba stage

**Files:**
- Modify: `orchestrator/src/registry.js`
- Modify: `orchestrator/src/planner.js`
- Modify: `orchestrator/test/registry.test.js`

**Interfaces:**
- Consumes: nothing new at runtime; the descriptor's `build({ port, upstreamBase, config })` returns `{ args, env }` where `args[0]` is the absolute path to `bin/compact-interceptor.js`.
- Produces: `REGISTRY['compact-router']` with `builtin: true`, `bin: process.execPath`, `terminal: false`, `healthPath: '/health'`, `defaultPort: 47850`.
- planner change: `plan()` passes the whole `config` into each `descriptor.build(...)` call so builtin stages can read their settings block.

- [ ] **Step 1: Write the failing test (extend registry.test.js)**

Append to `orchestrator/test/registry.test.js`:
```js
test('compact-router is a builtin node stage wired from config', () => {
  const d = REGISTRY['compact-router'];
  assert.equal(d.builtin, true);
  assert.equal(d.terminal, false);
  assert.equal(d.healthPath, '/health');
  assert.equal(d.bin, process.execPath);
  const { args, env } = d.build({
    port: 47850, upstreamBase: 'http://127.0.0.1:8787',
    config: { compactRouter: { model: 'deepseek/deepseek-v4-flash' } },
  });
  assert.match(args[0], /bin\/compact-interceptor\.js$/);
  assert.equal(env.PORT, '47850');
  assert.equal(env.COMPACT_UPSTREAM, 'http://127.0.0.1:8787');
  assert.equal(env.COMPACT_MODEL, 'deepseek/deepseek-v4-flash');
  assert.equal(env.COMPACT_BASE_URL, 'https://openrouter.ai/api/v1'); // default
  assert.equal(env.COMPACT_ENV_KEY, 'OPENROUTER_API_KEY'); // default
});

test('compact-router applies default model when config omits it', () => {
  const { env } = REGISTRY['compact-router'].build({ port: 1, upstreamBase: 'http://x' });
  assert.equal(env.COMPACT_MODEL, 'deepseek/deepseek-v4-flash');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/registry.test.js`
Expected: FAIL — `REGISTRY['compact-router']` is undefined.

- [ ] **Step 3: Add the descriptor to registry.js**

At the top of `orchestrator/src/registry.js` add the import:
```js
import { fileURLToPath } from 'node:url';

const COMPACT_BIN = fileURLToPath(new URL('../bin/compact-interceptor.js', import.meta.url));
```

Add this entry inside the `REGISTRY` object (alongside pxpipe/headroom/router):
```js
  'compact-router': {
    id: 'compact-router',
    builtin: true,
    bin: process.execPath,
    defaultPort: 47850,
    dialect: 'anthropic',
    terminal: false,
    healthPath: '/health',
    build({ port, upstreamBase, config }) {
      const c = (config && config.compactRouter) || {};
      return {
        args: [COMPACT_BIN],
        env: {
          PORT: String(port),
          COMPACT_UPSTREAM: upstreamBase,
          COMPACT_MODEL: c.model || 'deepseek/deepseek-v4-flash',
          COMPACT_BASE_URL: c.baseUrl || 'https://openrouter.ai/api/v1',
          COMPACT_ENV_KEY: c.envKey || 'OPENROUTER_API_KEY',
        },
      };
    },
  },
```

- [ ] **Step 4: Pass `config` into build() in planner.js**

In `orchestrator/src/planner.js`, find the chain-building `.map` where it calls `s.d.build({ port: s.port, upstreamBase, provider })` and change it to include `config`:
```js
    const { args, env } = s.d.build({ port: s.port, upstreamBase, provider, config });
```
(`config` is already the first parameter of `plan(config, registry)`, so it's in scope. No other change.)

- [ ] **Step 5: Run to verify it passes (registry + planner suites)**

Run: `cd orchestrator && node --test test/registry.test.js test/planner.test.js`
Expected: PASS — new compact-router registry tests pass; all existing planner tests still pass (adding `config` to the build call is backward-compatible; other descriptors ignore it).

- [ ] **Step 6: Sanity — plan a chain that includes compact-router**

Run:
```bash
cd orchestrator && node -e "import('./src/planner.js').then(({plan})=>{const r=plan({terminal:'anthropic',compressors:['compact-router','headroom'],compactRouter:{model:'deepseek/deepseek-v4-flash'}});console.log('ok:',r.ok);console.log('chain:',r.chain.map(s=>s.id+':'+s.port).join(' -> '));console.log('cr env model:',r.chain[0].spawn.env.COMPACT_MODEL,'upstream:',r.chain[0].spawn.env.COMPACT_UPSTREAM)})"
```
Expected: `ok: true`, chain `compact-router:47850 -> headroom:8787`, and the compact-router stage's env shows the model + `COMPACT_UPSTREAM=http://127.0.0.1:8787` (headroom's baseUrl).

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/registry.js orchestrator/src/planner.js orchestrator/test/registry.test.js
git commit -m "feat(compact): register compact-router builtin stage; planner passes config to build()"
```

---

## Task 5: Documentation

**Files:**
- Modify: `orchestrator/README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a `compact-router` section to `orchestrator/README.md`**

Cover: what it does (intercepts Claude Code's `/compact`/autocompact summarization request and serves it from a cheap model, everything else passes through); why it saves money (the compaction reads the whole context on the flagship — ~$1.5–13 per Fable 1M compaction — this reroutes just that request); config (`compressors: ["compact-router", ...]` recommended FIRST, plus the optional `compactRouter: { model, baseUrl, envKey }` block, default `deepseek/deepseek-v4-flash` via OpenRouter using `OPENROUTER_API_KEY`); the fallback guarantee (any external failure → transparent passthrough, `/compact` never breaks); and the quality caveat (a cheap model makes a rougher summary — raise the model if summaries degrade). Mention Phase 2 `context-watchdog` (proactive compaction at a token threshold) is planned.

- [ ] **Step 2: Commit**

```bash
git add orchestrator/README.md
git commit -m "docs(compact): compact-router section"
```

---

## Self-Review

**Spec coverage:**
- §2 fingerprint → Task 1 matcher (+ real-text fixture). ✓
- §4.1 matcher → Task 1. ✓
- §4.2 translate (3 functions incl. SSE) → Task 2. ✓
- §4.3 server (health, intercept, stream/non-stream, fallback, passthrough) → Task 3 tests. ✓
- §4.4 bin entry (env, missing-key fail-fast) → Task 3 Steps 5–6. ✓
- §3.1 registry builtin descriptor → Task 4. ✓
- §3.2 planner passes config → Task 4 Step 4. ✓
- §3.3 config block → exercised in Task 4 Step 6 + documented Task 5. ✓
- §5 error handling (fallback, missing key, passthrough header hygiene) → Task 3 (fallback test + header stripping in `passthrough`), Task 3 Step 6 (missing key). ✓
- §6 testing (matcher/translate/server/registry) → Tasks 1–4. Live smoke is a post-merge controller step (noted). ✓
- §7 layout → matches File Structure. ✓

**Placeholder scan:** none — every step has complete code or an exact command.

**Type consistency:** `isCompactRequest(body)` (Task 1) is consumed by `server.js` (Task 3). `anthropicToOpenAI`/`openAIMessageToAnthropic`/`anthropicSSEChunks` (Task 2) are consumed by `server.js` (Task 3). `createInterceptor({port,upstream,model,baseUrl,apiKey,fetchImpl})` (Task 3) is invoked by `bin/compact-interceptor.js` (Task 3) with env-derived args. `REGISTRY['compact-router'].build({port,upstreamBase,config})` (Task 4) returns `{args,env}` consumed by the existing supervisor. `plan()` passing `config` into `build()` (Task 4) matches the descriptor signature. Names consistent.
