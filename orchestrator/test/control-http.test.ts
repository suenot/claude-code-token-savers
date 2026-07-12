import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlHttp, isLoopbackHost, redactSecrets } from '../src/control/http.ts';

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

test('POST /api/delegate with a cross-origin Origin header returns 403 (CSRF guard)', async () => {
  await withServer(async (base, engine) => {
    const res = await fetch(`${base}/api/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
      body: JSON.stringify({ task: 't' }),
    });
    assert.equal(res.status, 403);
    assert.equal(engine.calls.length, 0);
  });
});

test('POST /api/delegate without JSON content-type returns 415 (CSRF simple-request guard)', async () => {
  await withServer(async (base, engine) => {
    const res = await fetch(`${base}/api/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ task: 't' }),
    });
    assert.equal(res.status, 415);
    assert.equal(engine.calls.length, 0);
  });
});

test('POST /api/delegate with no Origin header still works (missing Origin is allowed)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 't' }),
    });
    assert.equal(res.status, 200);
  });
});

test('GET /health with a cross-origin Origin header returns 403 (Origin guard applies to all requests)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`, { headers: { origin: 'http://evil.com' } });
    assert.equal(res.status, 403);
  });
});

function stubCollector() {
  return {
    calls: [] as string[],
    async chain() {
      this.calls.push('chain');
      return [{ id: 'a', port: 4001, healthy: true }];
    },
    async stats() {
      this.calls.push('stats');
      return { totals: { events: 3, saved_pct: 60 } };
    },
    async recentRequests(limit?: number) {
      this.calls.push(`recentRequests:${limit ?? ''}`);
      return [{ id: 1 }];
    },
    async hopLog(limit?: number) {
      this.calls.push(`hopLog:${limit ?? ''}`);
      return [{ id: 2, stage: 'rate-limiter' }];
    },
  };
}

test('GET /api/chain returns the collector chain output', async () => {
  const engine = stubEngine();
  const collector = stubCollector();
  const server = createControlHttp(engine as any, { collector: collector as any });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chain`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ id: 'a', port: 4001, healthy: true }]);
    assert.deepEqual(collector.calls, ['chain']);
  } finally {
    server.close();
  }
});

test('GET /api/stats returns the collector stats output', async () => {
  const engine = stubEngine();
  const collector = stubCollector();
  const server = createControlHttp(engine as any, { collector: collector as any });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { totals: { events: 3, saved_pct: 60 } });
    assert.deepEqual(collector.calls, ['stats']);
  } finally {
    server.close();
  }
});

test('GET /api/requests returns the collector merged hopLog output', async () => {
  const engine = stubEngine();
  const collector = stubCollector();
  const server = createControlHttp(engine as any, { collector: collector as any });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/requests?limit=5`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ id: 2, stage: 'rate-limiter' }]);
    assert.deepEqual(collector.calls, ['hopLog:5']);
  } finally {
    server.close();
  }
});

test('GET /api/requests returns 404 when no collector is configured', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/requests`);
    assert.equal(res.status, 404);
  });
});

test('GET /api/chain returns 404 when no collector is configured', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/chain`);
    assert.equal(res.status, 404);
  });
});

test('GET /api/stats returns 404 when no collector is configured', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/stats`);
    assert.equal(res.status, 404);
  });
});

test('GET /api/config returns the loaded config with secret fields stripped', async () => {
  const engine = stubEngine();
  const config = {
    delegate: { defaultHarness: 'opencode', timeoutMs: 5000 },
    someApiKey: 'SECRET',
    anthropic: { apiKey: 'sk-secret', model: 'sonnet' },
    auth: { token: 'tok-secret', secretValue: 'also-secret' },
  };
  const server = createControlHttp(engine as any, { config: config as any });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      delegate: { defaultHarness: 'opencode', timeoutMs: 5000 },
      anthropic: { model: 'sonnet' },
      auth: {},
    });
  } finally {
    server.close();
  }
});

test('GET /api/config returns {} when no config is configured', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  });
});

test('GET /api/config with a cross-origin Origin header returns 403 (Origin guard applies)', async () => {
  const engine = stubEngine();
  const server = createControlHttp(engine as any, { config: { foo: 'bar' } as any });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { origin: 'http://evil.com' } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

function withStaticDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-console-'));
  writeFileSync(join(dir, 'index.html'), '<html><body><div id="root">spa-index</div></body></html>');
  writeFileSync(join(dir, 'main.js'), 'console.log("spa-main")');
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('GET / serves index.html from staticDir', async () => {
  await withStaticDir(async (dir) => {
    const engine = stubEngine();
    const server = createControlHttp(engine as any, { staticDir: dir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /spa-index/);
    } finally {
      server.close();
    }
  });
});

test('GET /some/spa/route falls back to index.html (SPA client-routing)', async () => {
  await withStaticDir(async (dir) => {
    const engine = stubEngine();
    const server = createControlHttp(engine as any, { staticDir: dir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/some/spa/route`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /spa-index/);
    } finally {
      server.close();
    }
  });
});

test('GET /main.js serves the real asset (not the SPA fallback)', async () => {
  await withStaticDir(async (dir) => {
    const engine = stubEngine();
    const server = createControlHttp(engine as any, { staticDir: dir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/main.js`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.match(body, /spa-main/);
    } finally {
      server.close();
    }
  });
});

test('GET /api/harnesses still returns JSON when staticDir is configured', async () => {
  await withStaticDir(async (dir) => {
    const engine = stubEngine();
    const server = createControlHttp(engine as any, { staticDir: dir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/harnesses`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), [{ id: 'opencode', bin: 'opencode', installed: true }]);
    } finally {
      server.close();
    }
  });
});

test('GET /api/unknown returns 404 (not the SPA fallback) when staticDir is configured', async () => {
  await withStaticDir(async (dir) => {
    const engine = stubEngine();
    const server = createControlHttp(engine as any, { staticDir: dir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/unknown`);
      assert.equal(res.status, 404);
      const body: any = await res.json();
      assert.ok(body.error);
    } finally {
      server.close();
    }
  });
});

function withTogglesServer(fn: (base: string, paths: { togglesPath: string; chainPath: string }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-toggles-http-'));
  const togglesPath = join(dir, 'runtime.json');
  const chainPath = join(dir, 'chain.json');
  writeFileSync(chainPath, JSON.stringify({ terminal: 'anthropic', compressors: ['headroom'] }, null, 2));
  const engine = stubEngine();
  const server = createControlHttp(engine as any, { togglesPath, chainPath });
  return new Promise<void>((resolve, reject) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const base = `http://127.0.0.1:${port}`;
      fn(base, { togglesPath, chainPath })
        .then(resolve, reject)
        .finally(() => {
          server.close();
          rmSync(dir, { recursive: true, force: true });
        });
    });
  });
}

test('GET /api/toggles returns all known stages with correct live/restartRequired flags', async () => {
  await withTogglesServer(async (base) => {
    const res = await fetch(`${base}/api/toggles`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.deepEqual(
      body.map((s: any) => s.id).sort(),
      ['compact-router', 'context-watchdog', 'dedup', 'headroom', 'image-shrink', 'model-router', 'rate-limiter'],
    );
    const byId = Object.fromEntries(body.map((s: any) => [s.id, s]));
    assert.equal(byId['compact-router'].live, true);
    assert.equal(byId['compact-router'].restartRequired, false);
    assert.equal(byId['context-watchdog'].live, true);
    assert.equal(byId['context-watchdog'].restartRequired, false);
    assert.equal(byId['dedup'].live, true);
    assert.equal(byId['dedup'].restartRequired, false);
    assert.equal(byId['rate-limiter'].live, true);
    assert.equal(byId['rate-limiter'].restartRequired, false);
    assert.equal(byId['image-shrink'].live, true);
    assert.equal(byId['image-shrink'].restartRequired, false);
    assert.equal(byId['model-router'].live, true);
    assert.equal(byId['model-router'].restartRequired, false);
    assert.equal(byId['headroom'].live, false);
    assert.equal(byId['headroom'].restartRequired, true);
    // default (no runtime.json written yet): every stage enabled
    for (const s of body) assert.equal(s.enabled, true);
  });
});

test('POST /api/toggles disables rate-limiter, writing both runtime.json and chain.json', async () => {
  await withTogglesServer(async (base, { togglesPath, chainPath }) => {
    const res = await fetch(`${base}/api/toggles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'rate-limiter', enabled: false }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    const rl = body.find((s: any) => s.id === 'rate-limiter');
    assert.equal(rl.enabled, false);

    const runtimeWritten = JSON.parse(readFileSync(togglesPath, 'utf8'));
    assert.equal(runtimeWritten['rate-limiter'], false);

    const chainWritten = JSON.parse(readFileSync(chainPath, 'utf8'));
    assert.equal(chainWritten.toggles['rate-limiter'], false);
    assert.equal(chainWritten.terminal, 'anthropic'); // preserved existing keys
  });
});

test('POST /api/toggles for a restart-required stage still persists and reports restartRequired', async () => {
  await withTogglesServer(async (base, { chainPath }) => {
    const res = await fetch(`${base}/api/toggles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'headroom', enabled: false }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    const hr = body.find((s: any) => s.id === 'headroom');
    assert.equal(hr.enabled, false);
    assert.equal(hr.restartRequired, true);
    const chainWritten = JSON.parse(readFileSync(chainPath, 'utf8'));
    assert.equal(chainWritten.toggles.headroom, false);
  });
});

test('POST /api/toggles with an unknown stage returns 400', async () => {
  await withTogglesServer(async (base) => {
    const res = await fetch(`${base}/api/toggles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'not-a-stage', enabled: false }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/toggles with a cross-origin Origin header returns 403 (CSRF guard)', async () => {
  await withTogglesServer(async (base) => {
    const res = await fetch(`${base}/api/toggles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
      body: JSON.stringify({ stage: 'rate-limiter', enabled: false }),
    });
    assert.equal(res.status, 403);
  });
});

test('GET /api/toggles with a cross-origin Origin header returns 403', async () => {
  await withTogglesServer(async (base) => {
    const res = await fetch(`${base}/api/toggles`, { headers: { origin: 'http://evil.com' } });
    assert.equal(res.status, 403);
  });
});

test('isLoopbackHost accepts loopback hosts and rejects everything else', () => {
  assert.equal(isLoopbackHost('127.0.0.1:47830'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('[::1]:80'), true);
  assert.equal(isLoopbackHost('evil.com'), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test('redactSecrets strips separator-delimited and bare secret-shaped keys at any depth', () => {
  const input = {
    OPENROUTER_API_KEY: 'sk-or-secret',
    api_key: 'a',
    'api-key': 'b',
    password: 'c',
    bearerToken: 'd',
    model: 'sonnet',
    harness: 'opencode',
    auth: { private_key: 'x', region: 'us' },
  };
  const out = redactSecrets(input) as Record<string, unknown>;
  assert.equal('OPENROUTER_API_KEY' in out, false);
  assert.equal('api_key' in out, false);
  assert.equal('api-key' in out, false);
  assert.equal('password' in out, false);
  assert.equal('bearerToken' in out, false);
  assert.equal(out.model, 'sonnet');
  assert.equal(out.harness, 'opencode');
  assert.deepEqual(out.auth, { region: 'us' });
  assert.equal((out.auth as Record<string, unknown>).private_key, undefined);
});

test('GET /%2e%2e/%2e%2e/etc/passwd (encoded traversal) does not escape staticDir', async () => {
  await withStaticDir(async (dir) => {
    const engine = stubEngine();
    const server = createControlHttp(engine as any, { staticDir: dir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/etc/passwd`);
      assert.ok(res.status === 200 || res.status === 404);
      const body = await res.text();
      assert.doesNotMatch(body, /root:/);
    } finally {
      server.close();
    }
  });
});

test('GET /../../etc/passwd (literal traversal) does not escape staticDir', async () => {
  await withStaticDir(async (dir) => {
    const engine = stubEngine();
    const server = createControlHttp(engine as any, { staticDir: dir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/../../etc/passwd`);
      assert.ok(res.status === 200 || res.status === 404);
      const body = await res.text();
      assert.doesNotMatch(body, /root:/);
    } finally {
      server.close();
    }
  });
});

function stubTasks() {
  return {
    calls: [] as any[],
    createTask(input: any) {
      this.calls.push(['createTask', input]);
      return { id: 'T-001', status: 'pending', ...input };
    },
    listTasks(status?: string) {
      this.calls.push(['listTasks', status]);
      return [{ id: 'T-001', status: status ?? 'pending', title: 'x' }];
    },
    getTask(id: string) {
      this.calls.push(['getTask', id]);
      return id === 'T-001' ? { id, status: 'completed', title: 'x' } : undefined;
    },
    updateStatus(id: string, _status: string) {
      this.calls.push(['updateStatus', id, _status]);
      return id === 'T-001';
    },
  };
}

async function withTasksServer(fn: (base: string, tasks: ReturnType<typeof stubTasks>) => Promise<void>) {
  const engine = stubEngine();
  const tasks = stubTasks();
  const server = createControlHttp(engine as any, { tasks: tasks as any });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, tasks);
  } finally {
    server.close();
  }
}

test('GET /api/tasks is not registered without a tasks collaborator', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/tasks`);
    assert.notEqual(res.status, 200);
  });
});

test('GET /api/tasks lists tasks, optionally filtered by ?status=', async () => {
  await withTasksServer(async (base, tasks) => {
    const res = await fetch(`${base}/api/tasks?status=pending`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ id: 'T-001', status: 'pending', title: 'x' }]);
    assert.deepEqual(tasks.calls[0], ['listTasks', 'pending']);
  });
});

test('POST /api/tasks creates a task, rejects a missing required field', async () => {
  await withTasksServer(async (base) => {
    const ok = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: 'high', title: 't', description: 'd', context_files: ['a.ts'] }),
    });
    assert.equal(ok.status, 200);
    const body: any = await ok.json();
    assert.equal(body.id, 'T-001');

    const bad = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priority: 'high', title: 't' }),
    });
    assert.equal(bad.status, 400);
  });
});

test('POST /api/tasks/:id updates status, 404s for unknown id, 400s for bad status', async () => {
  await withTasksServer(async (base) => {
    const ok = await fetch(`${base}/api/tasks/T-001`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(ok.status, 200);

    const notFound = await fetch(`${base}/api/tasks/T-999`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    assert.equal(notFound.status, 404);

    const badStatus = await fetch(`${base}/api/tasks/T-001`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'bogus' }),
    });
    assert.equal(badStatus.status, 400);
  });
});
