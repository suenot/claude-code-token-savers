import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/control/mcp.ts';

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
    async experimentRun(i: any) {
      this.calls.push(['experimentRun', i]);
      return { experiment_id: 'exp_1', job_ids: ['job_1'] };
    },
    experimentStatus(id: string) {
      return { id, status: 'running', candidates: [], winnerJobId: null, reason: '' };
    },
  };
}

test('MCP exposes the base tools and routes delegate', async () => {
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
  const res: any = await client.callTool({ name: 'shuba_delegate', arguments: { task: 'do it' } });
  assert.equal(engine.calls[0][0], 'delegate');
  assert.match(JSON.stringify(res.content), /job_1/);
});

test('MCP routes shuba_experiment_run to the engine', async () => {
  const engine = stubEngine();
  const server = createMcpServer(engine as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res: any = await client.callTool({
    name: 'shuba_experiment_run',
    arguments: { task: 'do it', variants: [{ harness: 'gemini' }, { harness: 'qwen' }] },
  });
  assert.equal(engine.calls[0][0], 'experimentRun');
  assert.match(JSON.stringify(res.content), /exp_1/);
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
      return [{ id: 'T-001', status: status ?? 'pending' }];
    },
    getTask(id: string) {
      this.calls.push(['getTask', id]);
      return { id, status: 'pending' };
    },
    updateStatus(id: string, status: string) {
      this.calls.push(['updateStatus', id, status]);
      return id === 'T-001';
    },
  };
}

function stubGateway() {
  return {
    calls: [] as any[],
    listServers() {
      this.calls.push(['listServers']);
      return [{ id: 'srv', name: 'Srv', running: true, toolCount: 2 }];
    },
    async listTools(id: string) {
      this.calls.push(['listTools', id]);
      return [{ name: 'ping' }];
    },
    async callTool(id: string, tool: string, args: unknown) {
      this.calls.push(['callTool', id, tool, args]);
      return { ok: true, echo: args };
    },
    dispose() {},
  };
}

test('MCP registers gateway tools only when a gateway is provided, and routes them', async () => {
  const engine = stubEngine();
  const gateway = stubGateway();
  const server = createMcpServer(engine as any, undefined, undefined, gateway as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);

  const toolNames = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.ok(toolNames.includes('shuba_gateway_list'));
  assert.ok(toolNames.includes('shuba_gateway_call'));

  // no `server` arg -> list servers
  const listRes: any = await client.callTool({ name: 'shuba_gateway_list', arguments: {} });
  assert.equal(gateway.calls[0][0], 'listServers');
  assert.match(JSON.stringify(listRes.content), /srv/);

  // with `server` -> list that server's tools
  await client.callTool({ name: 'shuba_gateway_list', arguments: { server: 'srv' } });
  assert.deepEqual(gateway.calls[1], ['listTools', 'srv']);

  const callRes: any = await client.callTool({
    name: 'shuba_gateway_call',
    arguments: { server: 'srv', tool: 'ping', args: { x: 1 } },
  });
  assert.equal(gateway.calls[2][0], 'callTool');
  assert.deepEqual(gateway.calls[2].slice(1), ['srv', 'ping', { x: 1 }]);
  assert.equal(JSON.parse(callRes.content[0].text).ok, true);
});

test('MCP omits gateway tools when no gateway is provided', async () => {
  const engine = stubEngine();
  const server = createMcpServer(engine as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const toolNames = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!toolNames.includes('shuba_gateway_list'));
  assert.ok(!toolNames.includes('shuba_gateway_call'));
});

test('MCP registers task tools only when a TaskManager is provided, and routes them', async () => {
  const engine = stubEngine();
  const tasks = stubTasks();
  const server = createMcpServer(engine as any, undefined, tasks as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const toolNames = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.ok(toolNames.includes('shuba_tasks_list'));
  assert.ok(toolNames.includes('shuba_tasks_create'));
  assert.ok(toolNames.includes('shuba_tasks_update'));

  await client.callTool({ name: 'shuba_tasks_create', arguments: { priority: 'high', title: 't', description: 'd' } });
  assert.equal(tasks.calls[0][0], 'createTask');

  await client.callTool({ name: 'shuba_tasks_list', arguments: {} });
  assert.equal(tasks.calls[1][0], 'listTasks');

  const res: any = await client.callTool({ name: 'shuba_tasks_update', arguments: { id: 'T-001', status: 'completed' } });
  assert.equal(tasks.calls[2][0], 'updateStatus');
  assert.equal(JSON.parse(res.content[0].text).updated, true);
});
