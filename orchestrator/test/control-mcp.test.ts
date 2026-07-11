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
  };
}

test('MCP exposes four tools and routes delegate', async () => {
  const engine = stubEngine();
  const server = createMcpServer(engine as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['shuba_delegate', 'shuba_harness_list', 'shuba_job_result', 'shuba_job_status']);
  const res: any = await client.callTool({ name: 'shuba_delegate', arguments: { task: 'do it' } });
  assert.equal(engine.calls[0][0], 'delegate');
  assert.match(JSON.stringify(res.content), /job_1/);
});
