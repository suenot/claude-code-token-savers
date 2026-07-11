# context-watchdog (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A built-in shuba stage that keeps the session context small by rewriting any `/v1/messages` request over a token threshold (default 300k): summarize the older turns via a cheap model, forward the flagship a shortened body, and proxy the response back untouched.

**Architecture:** Pure `estimate` + `cut` + `rewrite` helpers, a stateful request-mutating passthrough `server` (content-addressed summary cache), wired into shuba as a `context-watchdog` builtin stage. Reuses Phase 1's `src/compact/translate.js` and `src/compact/matcher.js`. Node built-ins only.

**Tech Stack:** Node ≥18 (ESM, `node:test`, `node:http`, `node:stream`, `node:crypto`), global `fetch`. No runtime deps. Develop in `orchestrator/`.

## Global Constraints

- Node ≥18, ESM (`"type":"module"`), NO runtime npm deps, dev/test Node built-ins only.
- Files under `orchestrator/`. Match existing shuba/compact style.
- Reuse Phase 1: `import { isCompactRequest } from '../compact/matcher.js'` and `import { anthropicToOpenAI } from '../compact/translate.js'`.
- The watchdog rewrites the REQUEST only; the flagship RESPONSE is proxied back untouched (strip `content-encoding`/`content-length`/`transfer-encoding`, pipe the stream).
- Token estimate is char-based, dependency-free: `ceil(totalContentChars / 4)`.
- Default threshold 300000 tokens; default tail 6 turns; default model `deepseek/deepseek-v4-flash` via OpenRouter (`OPENROUTER_API_KEY`).
- On ANY summarize/rewrite failure → forward the ORIGINAL request unchanged. A compact-fingerprinted request (`isCompactRequest`) → passthrough unchanged. Under-threshold → passthrough unchanged.
- Safe cut: the tail must start with a `role:'user'` message and must not begin with an orphan `tool_result`; older prefix must be non-empty, else no compaction (passthrough).
- `context-watchdog` is a builtin stage: `bin` = `process.execPath`, `args` = `[<abs path to bin/context-watchdog.js>]`, non-terminal, health `/health`, defaultPort 47851.

---

## File Structure

```
orchestrator/
  bin/context-watchdog.js
  src/watchdog/estimate.js
  src/watchdog/cut.js
  src/watchdog/rewrite.js
  src/watchdog/server.js
  src/registry.js                 # + context-watchdog descriptor (MODIFY)
  test/watchdog-estimate.test.js
  test/watchdog-cut.test.js
  test/watchdog-rewrite.test.js
  test/watchdog-server.test.js
  test/registry.test.js           # + context-watchdog assertions (MODIFY)
  README.md                       # + context-watchdog section (MODIFY)
```

---

## Task 1: estimate (pure)

**Files:**
- Create: `orchestrator/src/watchdog/estimate.js`
- Test: `orchestrator/test/watchdog-estimate.test.js`

**Interfaces:**
- Produces: `estimateTokens(body): number` — `ceil(totalChars/4)` over `system` (string or text-block array) plus every message's flattened content text (text blocks + tool_use/tool_result/image flattened to their text form). Empty/missing → 0.

- [ ] **Step 1: Write the failing test**

`orchestrator/test/watchdog-estimate.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from '../src/watchdog/estimate.js';

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/watchdog-estimate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement estimate.js**

`orchestrator/src/watchdog/estimate.js`:
```js
function flatten(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b) return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool_use') return `${b.name || ''}${JSON.stringify(b.input ?? {})}`;
    if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
    return '';
  }).join('');
}

export function estimateTokens(body) {
  let chars = 0;
  if (body && body.system) chars += flatten(body.system).length;
  for (const m of (body && body.messages) || []) chars += flatten(m.content).length;
  return Math.ceil(chars / 4);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && node --test test/watchdog-estimate.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/watchdog/estimate.js orchestrator/test/watchdog-estimate.test.js
git commit -m "feat(watchdog): char-based token estimator"
```

---

## Task 2: cut (pure)

**Files:**
- Create: `orchestrator/src/watchdog/cut.js`
- Test: `orchestrator/test/watchdog-cut.test.js`

**Interfaces:**
- Produces: `planCut(messages, tailTurns): { older, tail } | null` — split `messages` so `tail` is the last ~`tailTurns` messages but adjusted so `tail[0].role === 'user'` and `tail[0]` is not an orphan `tool_result` (a user message whose content is/*starts with* a `tool_result` block); `older` is everything before. Returns `null` if `older` would be empty or no safe cut exists.

Helper semantics: a message "starts with tool_result" iff its `content` is an array whose first block has `type:'tool_result'`. The cut index starts at `max(0, len - tailTurns)` and moves **backward** (toward 0) until `messages[cut]` is a user message that does not start with a `tool_result`. If it reaches 0, `older` is empty → return `null`.

- [ ] **Step 1: Write the failing test**

`orchestrator/test/watchdog-cut.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCut } from '../src/watchdog/cut.js';

const U = (t) => ({ role: 'user', content: t });
const A = (t) => ({ role: 'assistant', content: t });
const TR = () => ({ role: 'user', content: [{ type: 'tool_result', content: 'x' }] });

test('clean boundary: tail is last tailTurns starting at a user msg', () => {
  const msgs = [U('1'), A('2'), U('3'), A('4'), U('5'), A('6')];
  const r = planCut(msgs, 2); // len 6, cut=4 → messages[4]=U('5') ok
  assert.deepEqual(r.tail.map((m) => m.content), ['5', '6']);
  assert.deepEqual(r.older.map((m) => m.content), ['1', '2', '3', '4']);
});

test('extends backward when boundary lands on assistant', () => {
  const msgs = [U('1'), A('2'), U('3'), A('4'), U('5'), A('6'), U('7'), A('8')];
  const r = planCut(msgs, 3); // len 8, cut=5 → A('6') not user → move to 4 U('5')
  assert.equal(r.tail[0].content, '5');
  assert.equal(r.older[r.older.length - 1].content, '4');
});

test('skips an orphan tool_result at the tail start', () => {
  const msgs = [U('1'), A('2'), U('3'), A('4'), TR(), A('6')];
  const r = planCut(msgs, 2); // cut=4 → TR() starts with tool_result → move back to U('3') at idx 2
  assert.equal(r.tail[0].content, '3');
});

test('returns null when nothing is older than the tail', () => {
  const msgs = [U('1'), A('2')];
  assert.equal(planCut(msgs, 5), null); // cut would be 0 → older empty
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/watchdog-cut.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cut.js**

`orchestrator/src/watchdog/cut.js`:
```js
function startsWithToolResult(m) {
  return Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result';
}

export function planCut(messages, tailTurns) {
  const msgs = Array.isArray(messages) ? messages : [];
  let cut = Math.max(0, msgs.length - tailTurns);
  while (cut > 0 && (msgs[cut].role !== 'user' || startsWithToolResult(msgs[cut]))) {
    cut--;
  }
  if (cut <= 0) return null;
  return { older: msgs.slice(0, cut), tail: msgs.slice(cut) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && node --test test/watchdog-cut.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/watchdog/cut.js orchestrator/test/watchdog-cut.test.js
git commit -m "feat(watchdog): safe cut-point planner"
```

---

## Task 3: rewrite (pure)

**Files:**
- Create: `orchestrator/src/watchdog/rewrite.js`
- Test: `orchestrator/test/watchdog-rewrite.test.js`

**Interfaces:**
- Produces:
  - `summaryKey(older): string` — `sha256(hex)` of a canonical JSON of `older` (stable for identical input).
  - `buildRewrittenBody(body, tail, summaryText): body` — returns a shallow clone of `body` with `system` preserved and `messages` = `[{role:'user', content:'Summary of the earlier conversation so far:\n\n' + summaryText}, {role:'assistant', content:'Understood. Continuing from that summary.'}, ...tail]`.

- [ ] **Step 1: Write the failing test**

`orchestrator/test/watchdog-rewrite.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryKey, buildRewrittenBody } from '../src/watchdog/rewrite.js';

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
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  // original body not mutated
  assert.deepEqual(body.messages, [{ role: 'user', content: 'orig' }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/watchdog-rewrite.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement rewrite.js**

`orchestrator/src/watchdog/rewrite.js`:
```js
import { createHash } from 'node:crypto';

export function summaryKey(older) {
  return createHash('sha256').update(JSON.stringify(older)).digest('hex');
}

export function buildRewrittenBody(body, tail, summaryText) {
  const messages = [
    { role: 'user', content: 'Summary of the earlier conversation so far:\n\n' + summaryText },
    { role: 'assistant', content: 'Understood. Continuing from that summary.' },
    ...tail,
  ];
  return { ...body, messages };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && node --test test/watchdog-rewrite.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/watchdog/rewrite.js orchestrator/test/watchdog-rewrite.test.js
git commit -m "feat(watchdog): content-addressed summary key + request rewriter"
```

---

## Task 4: server + bin

**Files:**
- Create: `orchestrator/src/watchdog/server.js`
- Create: `orchestrator/bin/context-watchdog.js`
- Test: `orchestrator/test/watchdog-server.test.js`

**Interfaces:**
- Consumes: `isCompactRequest` (compact/matcher.js), `anthropicToOpenAI` (compact/translate.js), `estimateTokens`, `planCut`, `summaryKey`, `buildRewrittenBody`.
- Produces: `createWatchdog({ port, upstream, model, baseUrl, apiKey, thresholdTokens, tailTurns, fetchImpl = fetch, cache = new Map() }): http.Server` — does NOT call `.listen()` itself (caller listens), mirroring the Phase-1 server. `GET /health` → 200 `{"status":"ok"}`. `POST …/v1/messages` (not count_tokens): passthrough unless over threshold, non-compact, and a safe cut exists; then summarize (cache-first) and forward a rewritten body; any error → forward original.

- [ ] **Step 1: Write the failing test**

`orchestrator/test/watchdog-server.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createWatchdog } from '../src/watchdog/server.js';

// build an over-threshold body: many chars so estimateTokens > threshold(=10)
const big = 'x'.repeat(200);
const overBody = () => ({
  model: 'claude-opus-4-8', max_tokens: 1000,
  messages: [
    { role: 'user', content: big }, { role: 'assistant', content: big },
    { role: 'user', content: big }, { role: 'assistant', content: big },
    { role: 'user', content: 'recent-tail' }, { role: 'assistant', content: 'reply' },
  ],
});

async function withServer(opts, fn) {
  const srv = createWatchdog({
    port: 0, upstream: 'https://upstream.test', model: 'deepseek/deepseek-v4-flash',
    baseUrl: 'https://ext.test/v1', apiKey: 'k', thresholdTokens: 10, tailTurns: 2, ...opts,
  });
  srv.listen(0); await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(base); } finally { srv.close(); }
}

test('under-threshold request passes through, no summarize call', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, headers: new Headers(), body: null }; };
  await withServer({ fetchImpl, thresholdTokens: 1e9 }, async (base) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overBody()) });
    assert.ok(calls.every((u) => u.includes('upstream.test')));
    assert.ok(!calls.some((u) => u.includes('ext.test')));
  });
});

test('over-threshold: summarizes once, forwards rewritten body; 2nd call hits cache', async () => {
  const extCalls = []; let forwardedBody = null;
  const fetchImpl = async (url, opts) => {
    if (url.includes('ext.test')) { extCalls.push(1); return { ok: true, json: async () => ({ choices: [{ message: { content: 'SUM' } }] }) }; }
    forwardedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const cache = new Map();
  await withServer({ fetchImpl, cache }, async (base) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overBody()) });
    assert.equal(extCalls.length, 1);
    assert.match(forwardedBody.messages[0].content, /Summary of the earlier conversation so far:\n\nSUM/);
    assert.equal(forwardedBody.messages[0].role, 'user');
    // second identical request → cache hit, no new summarize call
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overBody()) });
    assert.equal(extCalls.length, 1);
  });
});

test('compact-fingerprinted request passes through untouched', async () => {
  const extCalls = [];
  const fetchImpl = async (url) => { if (url.includes('ext.test')) extCalls.push(1); return { ok: true, status: 200, headers: new Headers(), body: null }; };
  const body = overBody();
  body.messages[body.messages.length - 1] = { role: 'user', content: 'Your task is to create a detailed summary of the conversation so far.' };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(extCalls.length, 0); // never summarized
  });
});

test('summarize failure forwards the ORIGINAL body', async () => {
  let forwardedBody = null;
  const fetchImpl = async (url, opts) => {
    if (url.includes('ext.test')) throw new Error('model down');
    forwardedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overBody()) });
    assert.equal(forwardedBody.messages.length, 6); // original 6, not rewritten
    assert.equal(forwardedBody.messages[0].content, big); // unchanged
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/watchdog-server.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement server.js**

`orchestrator/src/watchdog/server.js`:
```js
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from '../compact/matcher.js';
import { anthropicToOpenAI } from '../compact/translate.js';
import { estimateTokens } from './estimate.js';
import { planCut } from './cut.js';
import { summaryKey, buildRewrittenBody } from './rewrite.js';

const SUMMARIZE_PROMPT =
  'Summarize the conversation above in detail — decisions, code, file paths, current ' +
  'state, and next steps — so work can continue without the original transcript. ' +
  'Respond with the summary only.';
const CACHE_CAP = 64;

export function createWatchdog({ port, upstream, model, baseUrl, apiKey, thresholdTokens, tailTurns, fetchImpl = fetch, cache = new Map() }) {
  const log = (...a) => process.stderr.write(`[context-watchdog] ${a.join(' ')}\n`);

  async function forward(req, bodyBuf, res) {
    const headers = { ...req.headers };
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, { method: req.method, headers, body: bodyBuf.length ? bodyBuf : undefined });
    const out = Object.fromEntries((up.headers && up.headers.entries) ? up.headers.entries() : []);
    delete out['content-encoding']; delete out['content-length']; delete out['transfer-encoding'];
    res.writeHead(up.status || 200, out);
    if (up.body) Readable.fromWeb(up.body).pipe(res);
    else res.end();
  }

  async function summarize(older, system) {
    const oreq = anthropicToOpenAI({ system, messages: [...older, { role: 'user', content: SUMMARIZE_PROMPT }] }, model);
    const r = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...oreq, stream: false }),
    });
    if (!r.ok) throw new Error(`external ${r.status}`);
    const data = await r.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('empty summary');
    return text;
  }

  function cacheGet(key) { return cache.get(key); }
  function cacheSet(key, val) {
    cache.set(key, val);
    while (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const isMessages = req.method === 'POST' && req.url.includes('/v1/messages') && !req.url.includes('count_tokens');
      let body = null;
      if (isMessages) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
      try {
        if (body && !isCompactRequest(body) && estimateTokens(body) > thresholdTokens) {
          const split = planCut(body.messages || [], tailTurns);
          if (split) {
            try {
              const key = summaryKey(split.older);
              let summary = cacheGet(key);
              if (!summary) { summary = await summarize(split.older, body.system); cacheSet(key, summary); log('summarized', key.slice(0, 8)); }
              else log('cache-hit', key.slice(0, 8));
              const rewritten = buildRewrittenBody(body, split.tail, summary);
              await forward(req, Buffer.from(JSON.stringify(rewritten)), res);
              return;
            } catch (e) {
              log('fallback', e.message);
              await forward(req, raw, res);
              return;
            }
          }
        }
        await forward(req, raw, res);
      } catch (e) {
        if (!res.headersSent) res.writeHead(502);
        res.end('context-watchdog error: ' + e.message);
      }
    });
  });
  return server;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd orchestrator && node --test test/watchdog-server.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the bin entry**

`orchestrator/bin/context-watchdog.js`:
```js
#!/usr/bin/env node
import { createWatchdog } from '../src/watchdog/server.js';

const port = Number(process.env.PORT || 47851);
const upstream = process.env.WATCHDOG_UPSTREAM || 'https://api.anthropic.com';
const model = process.env.WATCHDOG_MODEL || 'deepseek/deepseek-v4-flash';
const baseUrl = process.env.WATCHDOG_BASE_URL || 'https://openrouter.ai/api/v1';
const envKey = process.env.WATCHDOG_ENV_KEY || 'OPENROUTER_API_KEY';
const thresholdTokens = Number(process.env.WATCHDOG_THRESHOLD || 300000);
const tailTurns = Number(process.env.WATCHDOG_TAIL_TURNS || 6);
const apiKey = process.env[envKey];
if (!apiKey) {
  process.stderr.write(`[context-watchdog] missing API key: set ${envKey}\n`);
  process.exit(1);
}
createWatchdog({ port, upstream, model, baseUrl, apiKey, thresholdTokens, tailTurns }).listen(port);
process.stderr.write(`[context-watchdog] listening on 127.0.0.1:${port} → ${upstream} (compact >${thresholdTokens}tok via ${model})\n`);
```

- [ ] **Step 6: Verify the bin fails fast without a key**

Run: `cd orchestrator && env -u OPENROUTER_API_KEY WATCHDOG_ENV_KEY=OPENROUTER_API_KEY node bin/context-watchdog.js; echo "exit=$?"`
Expected: prints `[context-watchdog] missing API key: set OPENROUTER_API_KEY` and `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/watchdog/server.js orchestrator/bin/context-watchdog.js orchestrator/test/watchdog-server.test.js
git commit -m "feat(watchdog): stateful request-rewriting server + bin"
```

---

## Task 5: register `context-watchdog` builtin stage

**Files:**
- Modify: `orchestrator/src/registry.js`
- Modify: `orchestrator/test/registry.test.js`

**Interfaces:**
- Produces: `REGISTRY['context-watchdog']` with `builtin:true`, `bin:process.execPath`, `defaultPort:47851`, dialect anthropic, `terminal:false`, health `/health`; `build({port,upstreamBase,config})` returns `{ args:[WATCHDOG_BIN], env }` with env `PORT`/`WATCHDOG_UPSTREAM`/`WATCHDOG_MODEL`/`WATCHDOG_BASE_URL`/`WATCHDOG_ENV_KEY`/`WATCHDOG_THRESHOLD`/`WATCHDOG_TAIL_TURNS` from `config.contextWatchdog` with defaults (300000, 6, deepseek/deepseek-v4-flash, OpenRouter, OPENROUTER_API_KEY). No planner change (Phase 1 already passes `config`).

- [ ] **Step 1: Write the failing test (extend registry.test.js)**

Append to `orchestrator/test/registry.test.js`:
```js
test('context-watchdog builtin wires threshold/tail/model from config', () => {
  const d = REGISTRY['context-watchdog'];
  assert.equal(d.builtin, true);
  assert.equal(d.terminal, false);
  assert.equal(d.healthPath, '/health');
  assert.equal(d.bin, process.execPath);
  const { args, env } = d.build({
    port: 47851, upstreamBase: 'http://127.0.0.1:8787',
    config: { contextWatchdog: { thresholdTokens: 250000, tailTurns: 8 } },
  });
  assert.match(args[0], /bin\/context-watchdog\.js$/);
  assert.equal(env.PORT, '47851');
  assert.equal(env.WATCHDOG_UPSTREAM, 'http://127.0.0.1:8787');
  assert.equal(env.WATCHDOG_THRESHOLD, '250000');
  assert.equal(env.WATCHDOG_TAIL_TURNS, '8');
  assert.equal(env.WATCHDOG_MODEL, 'deepseek/deepseek-v4-flash'); // default
});

test('context-watchdog applies defaults when config omits the block', () => {
  const { env } = REGISTRY['context-watchdog'].build({ port: 1, upstreamBase: 'http://x' });
  assert.equal(env.WATCHDOG_THRESHOLD, '300000');
  assert.equal(env.WATCHDOG_TAIL_TURNS, '6');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd orchestrator && node --test test/registry.test.js`
Expected: FAIL — `REGISTRY['context-watchdog']` undefined.

- [ ] **Step 3: Add the descriptor to registry.js**

At the top of `orchestrator/src/registry.js`, next to the existing `COMPACT_BIN`, add:
```js
const WATCHDOG_BIN = fileURLToPath(new URL('../bin/context-watchdog.js', import.meta.url));
```
(The `fileURLToPath` import already exists from Phase 1.)

Add this entry inside `REGISTRY`:
```js
  'context-watchdog': {
    id: 'context-watchdog',
    builtin: true,
    bin: process.execPath,
    defaultPort: 47851,
    dialect: 'anthropic',
    terminal: false,
    healthPath: '/health',
    build({ port, upstreamBase, config }) {
      const c = (config && config.contextWatchdog) || {};
      return {
        args: [WATCHDOG_BIN],
        env: {
          PORT: String(port),
          WATCHDOG_UPSTREAM: upstreamBase,
          WATCHDOG_MODEL: c.model || 'deepseek/deepseek-v4-flash',
          WATCHDOG_BASE_URL: c.baseUrl || 'https://openrouter.ai/api/v1',
          WATCHDOG_ENV_KEY: c.envKey || 'OPENROUTER_API_KEY',
          WATCHDOG_THRESHOLD: String(c.thresholdTokens ?? 300000),
          WATCHDOG_TAIL_TURNS: String(c.tailTurns ?? 6),
        },
      };
    },
  },
```

- [ ] **Step 4: Run to verify it passes (registry + planner)**

Run: `cd orchestrator && node --test test/registry.test.js test/planner.test.js`
Expected: PASS — new context-watchdog tests pass; planner unaffected.

- [ ] **Step 5: Sanity — plan a chain with both stages**

Run:
```bash
cd orchestrator && node -e "import('./src/planner.js').then(({plan})=>{const r=plan({terminal:'anthropic',compressors:['compact-router','context-watchdog','headroom'],contextWatchdog:{thresholdTokens:300000}});console.log('ok:',r.ok,'|',r.chain.map(s=>s.id+':'+s.port).join(' -> '))})"
```
Expected: `ok: true | compact-router:47850 -> context-watchdog:47851 -> headroom:8787`.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/registry.js orchestrator/test/registry.test.js
git commit -m "feat(watchdog): register context-watchdog builtin stage"
```

---

## Task 6: Documentation

**Files:**
- Modify: `orchestrator/README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a `context-watchdog` section to `orchestrator/README.md`**

Cover: what it does (rewrites any over-threshold request — default 300k tokens — by summarizing the older turns via a cheap model and forwarding the flagship a shortened body; the response is proxied back untouched); why (smaller context is cheaper and higher-quality, §3; it caps context proactively instead of waiting for autocompact near 1M); the mechanism honesty (a proxy can't make Claude Code run `/compact`, so it rewrites the request; Claude Code keeps its full transcript, only the model sees the compacted version); config (`compressors: ["compact-router", "context-watchdog", ...]` — put it after compact-router; `contextWatchdog: { thresholdTokens, tailTurns, model }`, defaults 300000 / 6 / deepseek-v4-flash); the stateful cache (content-addressed, so the prefix stays cache-stable and it only re-summarizes when the cut advances); the fallback guarantee (summarize failure → original request forwarded); the interaction with compact-router (watchdog skips `/compact` requests; they're handled by compact-router). Show a chain.json example enabling both stages.

- [ ] **Step 2: Commit**

```bash
git add orchestrator/README.md
git commit -m "docs(watchdog): context-watchdog section"
```

---

## Self-Review

**Spec coverage:**
- §2 estimate (char/4) → Task 1. ✓
- §2 safe cut → Task 2. ✓
- §2 injection + content-addressed key → Task 3. ✓
- §2/§3 server (threshold gate, compact skip, cache-first summarize, rewrite+forward, response untouched, fallback) → Task 4. ✓
- §4 bin (env, fail-fast) → Task 4 Steps 5–6. ✓
- §5 registry builtin + config defaults → Task 5. ✓
- §6 error handling (fallback to original, missing key, header hygiene) → Task 4 (fallback test + forward header stripping), Task 4 Step 6. ✓
- §7 testing (estimate/cut/rewrite/server/registry) → Tasks 1–5. Live smoke = post-merge. ✓
- §8 layout → matches File Structure. ✓

**Placeholder scan:** none — every step has complete code or an exact command.

**Type consistency:** `estimateTokens(body)` (T1), `planCut(messages,tailTurns)→{older,tail}|null` (T2), `summaryKey(older)`/`buildRewrittenBody(body,tail,summaryText)` (T3) are all consumed by `createWatchdog` (T4) with matching signatures. `createWatchdog({...})` (T4) is invoked by `bin/context-watchdog.js` (T4). `REGISTRY['context-watchdog'].build({port,upstreamBase,config})` (T5) returns `{args,env}` consumed by the existing supervisor; planner already passes `config`. Reused imports `isCompactRequest`/`anthropicToOpenAI` match their Phase-1 exports. Names consistent.
