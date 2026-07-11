import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createControlHttp, isLoopbackHost } from '../src/control/http.ts';

function stubEngine() {
  return {
    calls: [] as any[],
    async delegate(i: any) {
      this.calls.push(['delegate', i]);
      return { job_id: 'job_1', harness_chosen: 'opencode', model_chosen: 'm' };
    },
    status(id: string) {
      this.calls.push(['status', id]);
      return { status: 'running', harness: 'opencode', model: 'm', elapsed_ms: 5, tail: '…' };
    },
    result(id: string) {
      this.calls.push(['result', id]);
      return { status: 'done', result: 'ok', exit_code: 0, log_path: '/x.log' };
    },
    harnessList() {
      return [{ id: 'opencode', bin: 'opencode', installed: true }];
    },
    listJobs() {
      return [{ id: 'job_1', task: 't', harness: 'opencode', model: 'm', cwd: '/x', isolation: 'none', status: 'running', startedAt: 1, endedAt: null, exitCode: null }];
    },
  };
}

async function withServer(fn: (base: string, engine: ReturnType<typeof stubEngine>) => Promise<void>) {
  const engine = stubEngine();
  const server = createControlHttp(engine as any);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, engine);
  } finally {
    server.close();
  }
}

test('GET /health returns ok', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

test('GET /api/harnesses returns stub harness list', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/harnesses`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ id: 'opencode', bin: 'opencode', installed: true }]);
  });
});

test('GET /api/jobs returns stub job list', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/jobs`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].id, 'job_1');
  });
});

test('POST /api/delegate routes to engine.delegate and returns job_id', async () => {
  await withServer(async (base, engine) => {
    const res = await fetch(`${base}/api/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.job_id, 'job_1');
    assert.deepEqual(engine.calls[0], ['delegate', { task: 't' }]);
  });
});

test('GET /api/jobs/:id routes to engine.status', async () => {
  await withServer(async (base, engine) => {
    const res = await fetch(`${base}/api/jobs/job_1`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.status, 'running');
    assert.deepEqual(engine.calls[0], ['status', 'job_1']);
  });
});

test('GET /api/jobs/:id/result routes to engine.result', async () => {
  await withServer(async (base, engine) => {
    const res = await fetch(`${base}/api/jobs/job_1/result`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.result, 'ok');
    assert.deepEqual(engine.calls[0], ['result', 'job_1']);
  });
});

test('unknown route returns 404 json', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    const body: any = await res.json();
    assert.ok(body.error);
  });
});

test('POST /api/delegate with bad JSON returns 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});

test('GET /health with a spoofed cross-origin Host header returns 403 (DNS-rebinding guard)', async () => {
  await withServer(async (base) => {
    const { port } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: Number(port),
          path: '/health',
          method: 'GET',
          headers: { Host: 'evil.com' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test('isLoopbackHost accepts loopback hosts and rejects everything else', () => {
  assert.equal(isLoopbackHost('127.0.0.1:47830'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]:80'), true);
  assert.equal(isLoopbackHost('evil.com'), false);
  assert.equal(isLoopbackHost(undefined), false);
});
