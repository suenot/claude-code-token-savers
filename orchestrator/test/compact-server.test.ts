import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createInterceptor } from '../src/compact/server.ts';

const compactBody = (stream: boolean) => ({
  model: 'claude-opus-4-8', max_tokens: 64000, stream,
  messages: [{ role: 'user', content: 'Your task is to create a detailed summary of the conversation so far.' }],
});

async function withServer(fetchImpl: any, fn: (base: string) => Promise<any>) {
  const srv = createInterceptor({
    port: 0, upstream: 'https://upstream.test', model: 'deepseek/deepseek-v4-flash',
    baseUrl: 'https://ext.test/v1', apiKey: 'k', fetchImpl,
  });
  srv.listen(0);
  await once(srv, 'listening');
  const address = srv.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  try { return await fn(base); } finally { srv.close(); }
}

test('health returns ok', async () => {
  await withServer(async () => ({ ok: true }), async (base: string) => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
  });
});

test('compact request (non-stream) is served by the external model', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string, opts?: any) => {
    calls.push(url);
    if (url.includes('ext.test')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'CHEAP SUMMARY' } }] }) };
    }
    throw new Error('upstream should not be called');
  };
  await withServer(fetchImpl, async (base: string) => {
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
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.includes('ext.test')) throw new Error('model down');
    // upstream passthrough
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: null };
  };
  await withServer(fetchImpl, async (base: string) => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(compactBody(false)),
    });
    assert.equal(r.status, 200);
    assert.ok(calls.some((u) => u.includes('ext.test')), 'tried external first');
    assert.ok(calls.some((u) => u.includes('upstream.test/v1/messages')), 'fell back to upstream');
  });
});

test('compact request (stream) returns text/event-stream with named frames', async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes('ext.test')) return { ok: true, json: async () => ({ choices: [{ message: { content: 'S' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) };
    throw new Error('upstream should not be called');
  };
  await withServer(fetchImpl, async (base: string) => {
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(compactBody(true)) });
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    const body = await r.text();
    assert.match(body, /event: message_start\n/);
    assert.match(body, /event: content_block_delta\ndata: .*text_delta/);
    assert.match(body, /event: message_stop\n/);
  });
});

test('empty external content falls back to upstream', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.includes('ext.test')) return { ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) };
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer(fetchImpl, async (base: string) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(compactBody(false)) });
    assert.ok(calls.some((u) => u.includes('ext.test')));
    assert.ok(calls.some((u) => u.includes('upstream.test/v1/messages')));
  });
});

test('count_tokens path is passed through, never intercepted', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => { calls.push(url); return { ok: true, status: 200, headers: new Headers(), body: null }; };
  await withServer(fetchImpl, async (base: string) => {
    await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(compactBody(false)) });
    assert.ok(calls.every((u) => u.includes('upstream.test')));
    assert.ok(!calls.some((u) => u.includes('ext.test')));
  });
});

test('non-compact request passes through to upstream', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer(fetchImpl, async (base: string) => {
    await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'normal question' }] }),
    });
    assert.ok(calls.every((u) => u.includes('upstream.test')), 'only upstream called');
    assert.ok(!calls.some((u) => u.includes('ext.test')), 'external never called');
  });
});
