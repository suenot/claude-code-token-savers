import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { DelegateInput, ExperimentInput } from './types.ts';
import type { TaskManager } from './tasks.ts';
import type { McpGateway } from './mcp-gateway.ts';

export type Engine = {
  delegate(input: DelegateInput): Promise<unknown>;
  status(id: string): unknown;
  result(id: string): unknown;
  harnessList(): unknown;
  experimentRun(input: ExperimentInput): Promise<unknown>;
  experimentStatus(id: string): unknown;
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

export function createMcpServer(
  engine: Engine,
  graph?: Graph,
  tasks?: TaskManager,
  gateway?: McpGateway,
): McpServer {
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

  server.registerTool(
    'shuba_experiment_run',
    {
      description:
        'Run N candidate harnesses for one task (each in its own worktree) and keep the best. Returns an experiment id.',
      inputSchema: {
        task: z.string(),
        variants: z.array(z.object({ harness: z.string(), model: z.string().optional() })),
        scope: z.array(z.string()).optional(),
        validate: z.string().optional(),
        cwd: z.string().optional(),
      },
    },
    async (input) => textResult(await engine.experimentRun(input as ExperimentInput)),
  );

  server.registerTool(
    'shuba_experiment_status',
    {
      description: 'Get the status and winner of an experiment.',
      inputSchema: { experiment_id: z.string() },
    },
    async ({ experiment_id }) => textResult(engine.experimentStatus(experiment_id)),
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

  if (gateway) {
    server.registerTool(
      'shuba_gateway_list',
      {
        description:
          'List MCP servers imported into shuba, or, with `server`, list one server\'s tools. These are the MCP servers reachable through shuba-control as a gateway.',
        inputSchema: { server: z.string().optional() },
      },
      async ({ server }) =>
        textResult(server ? await gateway.listTools(server) : gateway.listServers()),
    );

    server.registerTool(
      'shuba_gateway_call',
      {
        description: 'Call a tool on an imported MCP server through the shuba-control gateway.',
        inputSchema: {
          server: z.string(),
          tool: z.string(),
          args: z.record(z.string(), z.unknown()).optional(),
        },
      },
      async ({ server, tool, args }) => textResult(await gateway.callTool(server, tool, args ?? {})),
    );
  }

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
