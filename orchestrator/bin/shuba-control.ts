#!/usr/bin/env bun
import { createEngine } from '../src/control/engine.ts';
import { createControlHttp } from '../src/control/http.ts';
import { createMcpServer, connectStdio } from '../src/control/mcp.ts';
import { createGraph } from '../src/control/graph.ts';
import type { DelegateConfig, Config } from '../src/types.ts';

const DEFAULT_CFG: DelegateConfig = {
  default: { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' },
};

function loadCfg(): DelegateConfig {
  const raw = process.env.DELEGATE_JSON;
  if (!raw) return DEFAULT_CFG;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.default) return parsed as DelegateConfig;
  } catch {
    // fall through to default
  }
  return DEFAULT_CFG;
}

function loadGraphCfg(): NonNullable<Config['graph']> {
  const raw = process.env.GRAPH_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as NonNullable<Config['graph']>;
  } catch {
    // fall through to default
  }
  return {};
}

const port = Number(process.env.PORT || 47830);
const cfg = loadCfg();
const graphCfg = loadGraphCfg();
const apiKey = process.env.OPENROUTER_API_KEY;
const projectCwd = process.cwd();

const engine = createEngine({ cfg, apiKey, projectCwd });
const graph = createGraph({ cwd: projectCwd, model: graphCfg.model });

// Two adapters, two processes, one role each — never both in the same
// process. The supervisor-spawned sidecar (registry sets
// SHUBA_CONTROL_HTTP=1 + PORT) serves HTTP only; the Claude-Code-spawned
// instance (registered via `.mcp.json`, no env) is stdio-MCP only. Running
// both in one process meant the second instance's `listen()` call collided
// on the same port (EADDRINUSE, uncaught) and killed the MCP process Claude
// Code depends on for delegation.
const httpEnabled = process.env.SHUBA_CONTROL_HTTP === '1';

if (httpEnabled) {
  const server = createControlHttp(engine, { graph });
  server.on('error', (e) => {
    process.stderr.write(`[shuba-control] http error: ${e.message}\n`);
  });
  server.listen(port, '127.0.0.1');
  process.stderr.write(
    `[shuba-control] role=http listening on 127.0.0.1:${port} (default harness: ${cfg.default.harness})\n`,
  );

  // Only the HTTP-role sidecar runs ensure/watch, so a stdio-MCP instance
  // (spawned per Claude Code session via .mcp.json) never starts a second
  // competing watcher — it only reads graph.json for status/query.
  if (graphCfg.enabled !== false) {
    graph
      .ensure({ autobuild: graphCfg.autobuild })
      .then((result) => {
        process.stderr.write(`[shuba-control] graph.ensure -> ${result.action}${result.reason ? ` (${result.reason})` : ''}\n`);
      })
      .catch((err) => {
        process.stderr.write(`[shuba-control] graph.ensure error: ${err instanceof Error ? err.message : String(err)}\n`);
      });
  }
} else {
  void connectStdio(createMcpServer(engine, graph));
  process.stderr.write(
    `[shuba-control] role=stdio-mcp (default harness: ${cfg.default.harness})\n`,
  );
}
