import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDedup } from '../src/dedup/server.ts';

const big = 'A'.repeat(300);
const marker = '[shuba-dedup: identical to block #1 above]';

// a body with two identical large text blocks → dedup rewrites the 2nd
const dupBody = () => ({
  model: 'claude-opus-4-8', max_tokens: 1000,
  messages: [
    { role: 'user', content: [{ type: 'text', text: big }] },
    { role: 'user', content: [{ type: 'text', text: big }] },
  ],
});

async function withServer(opts: any, fn: (base: string) => Promise<any>) {
  const srv = createDedup({ port: 0, upstream: 'https://upstream.test', ...opts });
  srv.listen(0); await once(srv, 'listening');
  const address = srv.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  try { return await fn(base); } finally { srv.close(); }
}

test('health route returns ok', async () => {
  await withServer({ fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: null }) }, async (base) => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
  });
});

test('duplicate blocks: forwards rewritten body with 2nd copy replaced by marker', async () => {
  let forwardedBody: any = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dupBody()) });
    assert.equal(forwardedBody.messages[0].content[0].text, big);
    assert.equal(forwardedBody.messages[1].content[0].text, marker);
  });
});

test('no duplicates: forwards the raw body untouched', async () => {
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const unique = { model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: big }] }] };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(unique) });
    assert.equal(forwardedRaw, JSON.stringify(unique));
  });
});

test('count_tokens requests pass through untouched', async () => {
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer({ fetchImpl }, async (base) => {
    const payload = JSON.stringify(dupBody());
    await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(forwardedRaw, payload); // never rewritten
  });
});

test('compact-fingerprinted request is forwarded untouched', async () => {
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const body = dupBody();
  body.messages.push({ role: 'user', content: [{ type: 'text', text: 'Your task is to create a detailed summary of the conversation so far.' }] } as any);
  const payload = JSON.stringify(body);
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(forwardedRaw, payload); // never deduped
  });
});

test('with the dedup toggle OFF, duplicate blocks are forwarded unrewritten', async () => {
  const prevRuntime = process.env.SHUBA_RUNTIME;
  const dir = mkdtempSync(join(tmpdir(), 'shuba-dedup-toggle-'));
  process.env.SHUBA_RUNTIME = join(dir, 'runtime.json');
  writeFileSync(process.env.SHUBA_RUNTIME, JSON.stringify({ dedup: false }));
  try {
    let forwardedRaw: string | null = null;
    const fetchImpl = async (_url: string, opts?: any) => {
      forwardedRaw = opts.body.toString();
      return { ok: true, status: 200, headers: new Headers(), body: null };
    };
    const payload = JSON.stringify(dupBody());
    await withServer({ fetchImpl }, async (base) => {
      await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      assert.equal(forwardedRaw, payload); // forwarded as-is while disabled
    });
  } finally {
    if (prevRuntime === undefined) delete process.env.SHUBA_RUNTIME;
    else process.env.SHUBA_RUNTIME = prevRuntime;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetch error surfaces as 502 (fail-open forward still attempted)', async () => {
  const fetchImpl = async () => { throw new Error('upstream down'); };
  await withServer({ fetchImpl }, async (base) => {
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dupBody()) });
    assert.equal(r.status, 502);
  });
});
