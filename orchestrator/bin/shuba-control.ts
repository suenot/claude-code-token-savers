#!/usr/bin/env bun
import { createEngine } from '../src/control/engine.ts';
import { createControlHttp } from '../src/control/http.ts';
import { createMcpServer, connectStdio } from '../src/control/mcp.ts';
import type { DelegateConfig } from '../src/types.ts';

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

const port = Number(process.env.PORT || 47830);
const cfg = loadCfg();
const apiKey = process.env.OPENROUTER_API_KEY;
const projectCwd = process.cwd();

const engine = createEngine({ cfg, apiKey, projectCwd });

// Two adapters, two processes, one role each — never both in the same
// process. The supervisor-spawned sidecar (registry sets
// SHUBA_CONTROL_HTTP=1 + PORT) serves HTTP only; the Claude-Code-spawned
// instance (registered via `.mcp.json`, no env) is stdio-MCP only. Running
// both in one process meant the second instance's `listen()` call collided
// on the same port (EADDRINUSE, uncaught) and killed the MCP process Claude
// Code depends on for delegation.
const httpEnabled = process.env.SHUBA_CONTROL_HTTP === '1';

if (httpEnabled) {
  const server = createControlHttp(engine);
  server.on('error', (e) => {
    process.stderr.write(`[shuba-control] http error: ${e.message}\n`);
  });
  server.listen(port, '127.0.0.1');
  process.stderr.write(
    `[shuba-control] role=http listening on 127.0.0.1:${port} (default harness: ${cfg.default.harness})\n`,
  );
} else {
  void connectStdio(createMcpServer(engine));
  process.stderr.write(
    `[shuba-control] role=stdio-mcp (default harness: ${cfg.default.harness})\n`,
  );
}
