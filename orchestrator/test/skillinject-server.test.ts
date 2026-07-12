import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillInject } from '../src/skillinject/server.ts';

const MANIFEST = [
  { id: 'seo', type: 'skill', name: 'SEO Audit', description: 'analyze a website for SEO', enabled: true },
];

const reqBody = () => ({
  model: 'claude-opus-4-8',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'run an SEO audit please' }],
});

function withStore(): { dir: string; storeDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-skillinject-'));
  const storeDir = dir;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
  return { dir, storeDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function withServer(opts: any, fn: (base: string) => Promise<any>) {
  const srv = createSkillInject({ port: 0, upstream: 'https://upstream.test', ...opts });
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

const classifierFetch = (async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({ ids: ['seo'] }) } }] }),
})) as any;

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

test('injects an Available skills system block, forwarded upstream', async () => {
  const store = withStore();
  let forwarded: any = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwarded = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  try {
    await withServer({ fetchImpl, classifierFetch, storeDir: store.storeDir }, async (base) => {
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqBody()),
      });
      assert.ok(forwarded.system);
      assert.match(forwarded.system, /Available skills/);
      assert.ok(forwarded.system.includes(`${store.storeDir}/skills/seo/SKILL.md`));
    });
  } finally {
    store.cleanup();
  }
});

test('empty manifest → request forwarded untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-skillinject-empty-'));
  writeFileSync(join(dir, 'manifest.json'), '[]');
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const payload = JSON.stringify(reqBody());
  try {
    await withServer({ fetchImpl, classifierFetch, storeDir: dir }, async (base) => {
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(forwardedRaw, payload);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabled:false → request forwarded untouched', async () => {
  const store = withStore();
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const payload = JSON.stringify(reqBody());
  try {
    await withServer(
      { enabled: false, fetchImpl, classifierFetch, storeDir: store.storeDir },
      async (base) => {
        await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        });
        assert.equal(forwardedRaw, payload);
      },
    );
  } finally {
    store.cleanup();
  }
});

test('classifier failure → fail open, request forwarded untouched', async () => {
  const store = withStore();
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const failingClassifier = (async () => ({ ok: false })) as any;
  const payload = JSON.stringify(reqBody());
  try {
    await withServer(
      { fetchImpl, classifierFetch: failingClassifier, storeDir: store.storeDir },
      async (base) => {
        await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
        });
        assert.equal(forwardedRaw, payload);
      },
    );
  } finally {
    store.cleanup();
  }
});

test('logs negative tokensSaved telemetry (this stage ADDS tokens)', async () => {
  const store = withStore();
  const prevReqlog = process.env.SHUBA_REQLOG;
  const logPath = join(store.dir, 'requests.jsonl');
  process.env.SHUBA_REQLOG = logPath;
  try {
    const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(), body: null });
    await withServer({ fetchImpl, classifierFetch, storeDir: store.storeDir }, async (base) => {
      await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reqBody()),
      });
    });
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const entry = JSON.parse(lines[lines.length - 1]!);
    assert.equal(entry.stage, 'skill-inject');
    assert.equal(entry.model, 'claude-opus-4-8');
    assert.ok(entry.tokensOut > entry.tokensIn, 'injection grows the request');
    assert.ok(entry.tokensSaved < 0, 'saving is negative by design');
    assert.equal(entry.tokensSaved, entry.tokensIn - entry.tokensOut);
  } finally {
    if (prevReqlog === undefined) delete process.env.SHUBA_REQLOG;
    else process.env.SHUBA_REQLOG = prevReqlog;
    store.cleanup();
  }
});

test('count_tokens requests pass through untouched', async () => {
  const store = withStore();
  let forwardedRaw: string | null = null;
  const fetchImpl = async (_url: string, opts?: any) => {
    forwardedRaw = opts.body.toString();
    return { ok: true, status: 200, headers: new Headers(), body: null };
  };
  const payload = JSON.stringify(reqBody());
  try {
    await withServer({ fetchImpl, classifierFetch, storeDir: store.storeDir }, async (base) => {
      await fetch(`${base}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(forwardedRaw, payload);
    });
  } finally {
    store.cleanup();
  }
});
