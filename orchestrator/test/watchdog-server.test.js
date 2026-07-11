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
