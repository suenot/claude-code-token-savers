import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { DelegateInput } from './types.ts';

export type Engine = {
  delegate(input: DelegateInput): Promise<unknown>;
  status(id: string): unknown;
  result(id: string): unknown;
  harnessList(): unknown;
};

const delegateInputShape = {
  task: z.string(),
  harness: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  files: z.array(z.string()).optional(),
  isolation: z.enum(['none', 'worktree']).optional(),
};

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer({ name: 'shuba-control', version: '0.1.0' });

  server.registerTool(
    'shuba_delegate',
    {
      description: 'Delegate a task to a coding harness (opencode, gemini, qwen, cursor-agent, claude).',
      inputSchema: delegateInputShape,
    },
    async (input) => textResult(await engine.delegate(input as DelegateInput)),
  );

  server.registerTool(
    'shuba_job_status',
    {
      description: 'Get the status of a delegated job.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => textResult(engine.status(job_id)),
  );

  server.registerTool(
    'shuba_job_result',
    {
      description: 'Get the result of a delegated job.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => textResult(engine.result(job_id)),
  );

  server.registerTool(
    'shuba_harness_list',
    {
      description: 'List available coding harnesses and whether they are installed.',
      inputSchema: {},
    },
    async () => textResult(engine.harnessList()),
  );

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
