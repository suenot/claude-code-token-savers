import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createWatchdog } from '../src/watchdog/server.ts';

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

async function withServer(opts: any, fn: (base: string) => Promise<any>) {
  const srv = createWatchdog({
    port: 0, upstream: 'https://upstream.test', model: 'deepseek/deepseek-v4-flash',
    baseUrl: 'https://ext.test/v1', apiKey: 'k', thresholdTokens: 10, tailTurns: 2, ...opts,
  });
  srv.listen(0); await once(srv, 'listening');
  const address = srv.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  try { return await fn(base); } finally { srv.close(); }
}

test('under-threshold request passes through, no summarize call', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => { calls.push(url); return { ok: true, status: 200, headers: new Headers(), body: null }; };
  await withServer({ fetchImpl, thresholdTokens: 1e9 }, async (base: string) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overBody()) });
    assert.ok(calls.every((u) => u.includes('upstream.test')));
    assert.ok(!calls.some((u) => u.includes('ext.test')));
  });
});

test('over-threshold: summarizes once, forwards rewritten body; 2nd call hits cache', async () => {
  const extCalls: number[] = []; let forwardedBody: any = null;
  const fetchImpl = async (url: string, opts?: any) => {
    if (url.includes('ext.test')) { extCalls.push(1); return { ok: true, json: async () => ({ choices: [{ message: { content: 'SUM' } }] }) }; }
    forwardedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const cache = new Map();
  await withServer({ fetchImpl, cache }, async (base: string) => {
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
  const extCalls: number[] = [];
  const fetchImpl = async (url: string) => { if (url.includes('ext.test')) extCalls.push(1); return { ok: true, status: 200, headers: new Headers(), body: null }; };
  const body = overBody();
  body.messages[body.messages.length - 1] = { role: 'user', content: 'Your task is to create a detailed summary of the conversation so far.' };
  await withServer({ fetchImpl }, async (base: string) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(extCalls.length, 0); // never summarized
  });
});

test('grown-but-small tail reuses the sticky summary (no re-summarize)', async () => {
  const extCalls: number[] = [];
  const fetchImpl = async (url: string) => {
    if (url.includes('ext.test')) { extCalls.push(1); return { ok: true, json: async () => ({ choices: [{ message: { content: 'SUM' } }] }) }; }
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer({ fetchImpl }, async (base: string) => {
    // turn 1: over threshold → summarize once
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overBody()) });
    assert.equal(extCalls.length, 1);
    // turn 2: same conversation + 2 more SMALL tail turns (tail still tiny) → reuse, no 2nd summarize
    const grown = overBody();
    grown.messages.push({ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' });
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(grown) });
    assert.equal(extCalls.length, 1);
  });
});

test('tail regrowing past threshold advances the cut (re-summarize)', async () => {
  const extCalls: number[] = [];
  const fetchImpl = async (url: string) => {
    if (url.includes('ext.test')) { extCalls.push(1); return { ok: true, json: async () => ({ choices: [{ message: { content: 'SUM' } }] }) }; }
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer({ fetchImpl }, async (base: string) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overBody()) });
    assert.equal(extCalls.length, 1);
    // append a BIG tail turn so the live tail alone exceeds threshold → must advance
    const grown = overBody();
    grown.messages.push({ role: 'user', content: big }, { role: 'assistant', content: big });
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(grown) });
    assert.equal(extCalls.length, 2);
  });
});

test('summarize failure forwards the ORIGINAL body', async () => {
  let forwardedBody: any = null;
  const fetchImpl = async (url: string, opts?: any) => {
    if (url.includes('ext.test')) throw new Error('model down');
    forwardedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer({ fetchImpl }, async (base: string) => {
    await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(overBody()) });
    assert.equal(forwardedBody.messages.length, 6); // original 6, not rewritten
    assert.equal(forwardedBody.messages[0].content, big); // unchanged
  });
});
