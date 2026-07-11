import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGate, retryAfterMs, createRateLimiter } from '../src/ratelimit/server.ts';
import { readReqLog } from '../src/control/reqlog.ts';

// A controllable clock: now() reads `clock`, sleep(ms) advances it synchronously
// so gate timing is deterministic without wall-clock waits.
function fakeClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => { clock += Math.max(0, ms); },
    advance: (ms: number) => { clock += ms; },
    get value() { return clock; },
  };
}

test('retryAfterMs: delta-seconds parsed, junk/absent falls back', () => {
  assert.equal(retryAfterMs('3', 5000), 3000);
  assert.equal(retryAfterMs('0', 5000), 0);
  assert.equal(retryAfterMs(null, 5000), 5000);
  assert.equal(retryAfterMs('not-a-number', 5000), 5000);
});

test('gate: burst passes immediately, then paces at rps', async () => {
  const c = fakeClock();
  const gate = createGate({ rps: 2, burst: 3, now: c.now, sleep: c.sleep });
  // 3 burst tokens: no wait.
  for (let i = 0; i < 3; i++) await gate.acquire();
  assert.equal(c.value, 0);
  // 4th must wait ~500ms (1 token / 2rps).
  await gate.acquire();
  assert.ok(c.value >= 500, `expected >=500ms, got ${c.value}`);
});

test('gate: penalize pauses the whole queue', async () => {
  const c = fakeClock();
  const gate = createGate({ rps: 100, burst: 100, now: c.now, sleep: c.sleep });
  gate.penalize(4000);
  await gate.acquire();
  assert.ok(c.value >= 4000, `expected cooldown >=4000ms, got ${c.value}`);
});

async function withServer(opts: any, fn: (base: string) => Promise<any>) {
  const srv = createRateLimiter({ port: 0, upstream: 'https://upstream.test', rps: 1000, burst: 1000, ...opts });
  srv.listen(0); await once(srv, 'listening');
  const address = srv.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  try { return await fn(base); } finally { srv.close(); }
}

test('forwards to upstream and returns status', async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => { calls.push(url); return { status: 200, headers: new Headers(), body: null }; };
  await withServer({ fetchImpl }, async (base) => {
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200);
    assert.ok(calls[0].includes('upstream.test/v1/messages'));
  });
});

test('forwarded request appends a rate-limiter reqlog entry with upstreamStatus', async () => {
  const prevReqLog = process.env.SHUBA_REQLOG;
  const dir = mkdtempSync(join(tmpdir(), 'shuba-ratelimit-reqlog-'));
  process.env.SHUBA_REQLOG = join(dir, 'requests.jsonl');
  try {
    const fetchImpl = async () => ({ status: 200, headers: new Headers(), body: null });
    await withServer({ fetchImpl }, async (base) => {
      const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 200);
    });
    const entries = readReqLog();
    const entry = entries.find((e) => e.stage === 'rate-limiter');
    assert.ok(entry, 'expected a rate-limiter reqlog entry');
    assert.equal(entry!.action, 'forward');
    assert.equal(typeof entry!.upstreamStatus, 'number');
  } finally {
    if (prevReqLog === undefined) delete process.env.SHUBA_REQLOG;
    else process.env.SHUBA_REQLOG = prevReqLog;
  }
});

test('upstream 429 triggers a global cooldown honoring Retry-After', async () => {
  const c = fakeClock();
  const fetchImpl = async () => ({ status: 429, headers: new Headers({ 'retry-after': '7' }), body: null });
  const penalties: number[] = [];
  await withServer({ fetchImpl, now: c.now, sleep: c.sleep, rps: 1000, burst: 1000 }, async (base) => {
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 429); // 429 passes through to client
    // Next request should wait out the 7s cooldown on the fake clock.
    await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
    assert.ok(c.value >= 7000, `expected cooldown >=7000ms, got ${c.value}`);
    penalties.push(c.value);
  });
});

test('with the rate-limiter toggle OFF, an upstream 429 does not pause the queue', async () => {
  const prevRuntime = process.env.SHUBA_RUNTIME;
  const dir = mkdtempSync(join(tmpdir(), 'shuba-ratelimit-toggle-'));
  process.env.SHUBA_RUNTIME = join(dir, 'runtime.json');
  writeFileSync(process.env.SHUBA_RUNTIME, JSON.stringify({ 'rate-limiter': false }));
  try {
    const c = fakeClock();
    const fetchImpl = async () => ({ status: 429, headers: new Headers({ 'retry-after': '7' }), body: null });
    await withServer({ fetchImpl, now: c.now, sleep: c.sleep, rps: 1000, burst: 1000 }, async (base) => {
      const r = await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
      assert.equal(r.status, 429);
      await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' });
      assert.equal(c.value, 0, `expected no pacing/cooldown while disabled, got ${c.value}`);
    });
  } finally {
    if (prevRuntime === undefined) delete process.env.SHUBA_RUNTIME;
    else process.env.SHUBA_RUNTIME = prevRuntime;
  }
});

test('health endpoint responds without gating', async () => {
  await withServer({ fetchImpl: async () => { throw new Error('should not forward'); } }, async (base) => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok' });
  });
});
