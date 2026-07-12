import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrush } from '../src/crush/server.ts';

const bigLog = Array.from({ length: 400 }, (_, i) => `log-${i}`).join('\n'); // > 2000 chars

const crushableBody = () => ({
  model: 'claude-opus-4-8',
  max_tokens: 1000,
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigLog }] }],
});

async function withServer(opts: any, fn: (base: string) => Promise<any>) {
  const srv = createCrush({ port: 0, upstream: 'https://upstream.test', ...opts });
  srv.listen(0);
  await once(srv, 'listening');
  const address = srv.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
  try {
    return await fn(base);
  } finally {
    srv.close();
  }
}

test('health route returns ok', async () => {
  await withServer(
    { fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: null }) },
    async (base) => {
      const r = await fetch(`${base}/health`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { status: 'ok' });
    },
  );
});

test('oversized tool_result: forwards a shrunken body with a crush marker', async () => {
  let forwardedBody: any = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(crushableBody()),
    });
    const sent = forwardedBody.messages[0].content[0].content;
    assert.ok(sent.length < bigLog.length);
    assert.match(sent, /… \[crushed \d+ chars\] …/);
  });
});

test('small tool_result: forwards the raw body untouched', async () => {
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const small = { model: 'x', messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'tiny' }] }] };
  await withServer({ fetchImpl }, async (base) => {
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(small),
    });
    assert.equal(forwardedRaw, JSON.stringify(small));
  });
});

test('count_tokens requests pass through untouched', async () => {
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  await withServer({ fetchImpl }, async (base) => {
    const payload = JSON.stringify(crushableBody());
    await fetch(`${base}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(forwardedRaw, payload);
  });
});

test('logs tokensIn/out/saved telemetry for a crush', async () => {
  const prevReqlog = process.env.SHUBA_REQLOG;
  const dir = mkdtempSync(join(tmpdir(), 'shuba-crush-log-'));
  const logPath = join(dir, 'requests.jsonl');
  process.env.SHUBA_REQLOG = logPath;
  try {
    const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(), body: null });
    await withServer({ fetchImpl }, async (base) => {
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(crushableBody()),
      });
    });
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const entry = JSON.parse(lines[lines.length - 1]!);
    assert.equal(entry.stage, 'crush');
    assert.equal(entry.model, 'claude-opus-4-8');
    assert.ok(entry.tokensIn > entry.tokensOut);
    assert.equal(entry.tokensSaved, entry.tokensIn - entry.tokensOut);
  } finally {
    if (prevReqlog === undefined) delete process.env.SHUBA_REQLOG;
    else process.env.SHUBA_REQLOG = prevReqlog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the crush toggle OFF, oversized tool_result is forwarded unrewritten', async () => {
  const prevRuntime = process.env.SHUBA_RUNTIME;
  const dir = mkdtempSync(join(tmpdir(), 'shuba-crush-toggle-'));
  process.env.SHUBA_RUNTIME = join(dir, 'runtime.json');
  writeFileSync(process.env.SHUBA_RUNTIME, JSON.stringify({ crush: false }));
  try {
    let forwardedRaw: string | null = null;
    const fetchImpl = async (_url: string, opts?: any) => {
      forwardedRaw = opts.body.toString();
      return { ok: true, status: 200, headers: new Headers(), body: null };
    };
    const payload = JSON.stringify(crushableBody());
    await withServer({ fetchImpl }, async (base) => {
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(forwardedRaw, payload);
    });
  } finally {
    if (prevRuntime === undefined) delete process.env.SHUBA_RUNTIME;
    else process.env.SHUBA_RUNTIME = prevRuntime;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabled:false forwards oversized tool_result unrewritten', async () => {
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const payload = JSON.stringify(crushableBody());
  await withServer({ enabled: false, fetchImpl }, async (base) => {
    await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(forwardedRaw, payload);
  });
});

test('fetch error surfaces as 502', async () => {
  const fetchImpl = async () => {
    throw new Error('upstream down');
  };
  await withServer({ fetchImpl }, async (base) => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(crushableBody()),
    });
    assert.equal(r.status, 502);
  });
});
