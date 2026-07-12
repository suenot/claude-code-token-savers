import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { DelegateInput } from './types.ts';
import type { TaskManager } from './tasks.ts';

export type Engine = {
  delegate(input: DelegateInput): Promise<unknown>;
  status(id: string): unknown;
  result(id: string): unknown;
  harnessList(): unknown;
};

export type Graph = {
  status(): unknown;
  query(query: string): unknown;
};

const delegateInputShape = {
  task: z.string(),
  harness: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  files: z.array(z.string()).optional(),
  isolation: z.enum(['none', 'worktree']).optional(),
  scope: z.array(z.string()).optional(),
  validate: z.string().optional(),
};

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function createMcpServer(engine: Engine, graph?: Graph, tasks?: TaskManager): McpServer {
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

  if (graph) {
    server.registerTool(
      'shuba_graph_query',
      {
        description: 'Query the codebase knowledge graph (explain or path query).',
        inputSchema: { query: z.string() },
      },
      async ({ query }) => textResult(graph.query(query)),
    );

    server.registerTool(
      'shuba_graph_status',
      {
        description: 'Get the status of the codebase knowledge graph.',
        inputSchema: {},
      },
      async () => textResult(graph.status()),
    );
  }

  if (tasks) {
    server.registerTool(
      'shuba_tasks_list',
      {
        description: 'List shuba tasks, optionally filtered by status (pending, completed, dismissed).',
        inputSchema: { status: z.enum(['pending', 'completed', 'dismissed']).optional() },
      },
      async ({ status }) => textResult(tasks.listTasks(status)),
    );

    server.registerTool(
      'shuba_tasks_create',
      {
        description: 'Create a new shuba task.',
        inputSchema: {
          priority: z.enum(['critical', 'high', 'medium', 'low']),
          title: z.string(),
          description: z.string(),
          context_files: z.array(z.string()).optional(),
          source: z.string().optional(),
        },
      },
      async ({ priority, title, description, context_files, source }) =>
        textResult(tasks.createTask({ priority, title, description, contextFiles: context_files, source })),
    );

    server.registerTool(
      'shuba_tasks_update',
      {
        description: 'Update a shuba task status (pending, completed, dismissed).',
        inputSchema: { id: z.string(), status: z.enum(['pending', 'completed', 'dismissed']) },
      },
      async ({ id, status }) => textResult({ updated: tasks.updateStatus(id, status) }),
    );
  }

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
