import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/control/mcp.ts';
import { createControlHttp } from '../src/control/http.ts';

function stubEngine() {
  return {
    calls: [] as any[],
    async delegate(i: any) {
      this.calls.push(['delegate', i]);
      return { job_id: 'job_1', harness_chosen: 'opencode', model_chosen: 'm' };
    },
    status() {
      return { status: 'running', harness: 'opencode', model: 'm', elapsed_ms: 5, tail: '…' };
    },
    result() {
      return { status: 'done', result: 'ok', exit_code: 0, log_path: '/x.log' };
    },
    harnessList() {
      return [{ id: 'opencode', bin: 'opencode', installed: true }];
    },
    listJobs() {
      return [];
    },
    async experimentRun(i: any) {
      this.calls.push(['experimentRun', i]);
      return { experiment_id: 'exp_1', job_ids: ['job_1'] };
    },
    experimentStatus(id: string) {
      return { id, status: 'running', candidates: [], winnerJobId: null, reason: '' };
    },
    experimentList() {
      return [];
    },
  };
}

function stubGraph() {
  return {
    calls: [] as any[],
    status() {
      this.calls.push(['status']);
      return { built: true, path: 'p', node_count: 2, last_built: 1, watching: true };
    },
    query(q: string) {
      this.calls.push(['query', q]);
      return { ok: true, result: 'R:' + q };
    },
  };
}

test('MCP exposes the base + graph tools and routes them', async () => {
  const engine = stubEngine();
  const graph = stubGraph();
  const server = createMcpServer(engine as any, graph as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'shuba_delegate',
    'shuba_experiment_run',
    'shuba_experiment_status',
    'shuba_graph_query',
    'shuba_graph_status',
    'shuba_harness_list',
    'shuba_job_result',
    'shuba_job_status',
  ]);

  const statusRes: any = await client.callTool({ name: 'shuba_graph_status', arguments: {} });
  assert.deepEqual(graph.calls[0], ['status']);
  assert.match(JSON.stringify(statusRes.content), /node_count/);

  const queryRes: any = await client.callTool({ name: 'shuba_graph_query', arguments: { query: 'X' } });
  assert.deepEqual(graph.calls[1], ['query', 'X']);
  assert.match(JSON.stringify(queryRes.content), /R:X/);
});

test('MCP without graph does not register graph tools', async () => {
  const engine = stubEngine();
  const server = createMcpServer(engine as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'shuba_delegate',
    'shuba_experiment_run',
    'shuba_experiment_status',
    'shuba_harness_list',
    'shuba_job_result',
    'shuba_job_status',
  ]);
});

async function withServer(
  graph: ReturnType<typeof stubGraph> | undefined,
  fn: (base: string, engine: ReturnType<typeof stubEngine>, graph?: ReturnType<typeof stubGraph>) => Promise<void>,
) {
  const engine = stubEngine();
  const server = createControlHttp(engine as any, graph ? { graph: graph as any } : undefined);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, engine, graph);
  } finally {
    server.close();
  }
}

test('GET /api/graph returns graph.status()', async () => {
  const graph = stubGraph();
  await withServer(graph, async (base) => {
    const res = await fetch(`${base}/api/graph`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.deepEqual(body, { built: true, path: 'p', node_count: 2, last_built: 1, watching: true });
  });
});

test('POST /api/graph/query returns graph.query(query)', async () => {
  const graph = stubGraph();
  await withServer(graph, async (base) => {
    const res = await fetch(`${base}/api/graph/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'X' }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.deepEqual(body, { ok: true, result: 'R:X' });
  });
});

test('POST /api/graph/query with cross-origin Origin returns 403', async () => {
  const graph = stubGraph();
  await withServer(graph, async (base) => {
    const res = await fetch(`${base}/api/graph/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
      body: JSON.stringify({ query: 'X' }),
    });
    assert.equal(res.status, 403);
  });
});

test('POST /api/graph/query without JSON content-type returns 415', async () => {
  const graph = stubGraph();
  await withServer(graph, async (base) => {
    const res = await fetch(`${base}/api/graph/query`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ query: 'X' }),
    });
    assert.equal(res.status, 415);
  });
});

test('GET /api/graph without graph configured returns 404', async () => {
  await withServer(undefined, async (base) => {
    const res = await fetch(`${base}/api/graph`);
    assert.equal(res.status, 404);
  });
});
