#!/usr/bin/env bun
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/control/engine.ts';
import { createControlHttp } from '../src/control/http.ts';
import { createCollector, type ChainStage } from '../src/control/collector.ts';
import { createMcpServer, connectStdio } from '../src/control/mcp.ts';
import { createGraph } from '../src/control/graph.ts';
import { REGISTRY } from '../src/registry.ts';
import type { DelegateConfig, Config } from '../src/types.ts';

// console/dist is the built SPA (see `bun run console:build`); resolved
// relative to this file so it works both run from source (bun bin/...) and
// from an installed package layout.
const CONSOLE_DIST = fileURLToPath(new URL('../console/dist', import.meta.url));

// Default chain-stage health probes for the collector's GET /api/chain. These
// mirror the ports/health paths declared in src/registry.ts for every stage
// that can appear in a proxy chain (the 'control' sidecar itself is excluded
// — it's not part of the request chain). Real per-run port overrides
// (config.ports) aren't threaded through to this sidecar process today, so
// this is a best-effort default set — a follow-up could pass the resolved
// PlannedStage list via env if per-run ports diverge from the registry
// defaults.
// Probe only the stages actually in the running chain (config.compressors,
// passed via CHAIN_JSON), not every registry entry — otherwise unused stages
// like the non-anthropic `router` show a false "down" in the console.
function chainStages(): ChainStage[] {
  let ids: string[] = [];
  const raw = process.env.CHAIN_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // fall through to default below
    }
  }
  if (ids.length === 0) {
    // Fallback: all non-terminal, non-control registry stages (excludes `router`).
    ids = Object.values(REGISTRY).filter((d) => d.id !== 'control' && !d.terminal).map((d) => d.id);
  }
  return ids
    .map((id) => REGISTRY[id])
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => ({ id: d.id, port: d.defaultPort, healthUrl: `http://127.0.0.1:${d.defaultPort}${d.healthPath}` }));
}

const DEFAULT_CHAIN_STAGES: ChainStage[] = chainStages();

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
const graph = createGraph({ cwd: projectCwd, model: graphCfg.model, noMedia: graphCfg.noMedia });

// Two adapters, two processes, one role each — never both in the same
// process. The supervisor-spawned sidecar (registry sets
// SHUBA_CONTROL_HTTP=1 + PORT) serves HTTP only; the Claude-Code-spawned
// instance (registered via `.mcp.json`, no env) is stdio-MCP only. Running
// both in one process meant the second instance's `listen()` call collided
// on the same port (EADDRINUSE, uncaught) and killed the MCP process Claude
// Code depends on for delegation.
const httpEnabled = process.env.SHUBA_CONTROL_HTTP === '1';

if (httpEnabled) {
  const collector = createCollector({ stages: DEFAULT_CHAIN_STAGES });
  const config = { delegate: cfg, graph: graphCfg };
  const server = createControlHttp(engine, { graph, staticDir: CONSOLE_DIST, collector, config });
  server.on('error', (e) => {
    process.stderr.write(`[shuba-control] http error: ${e.message}\n`);
  });
  server.listen(port, '127.0.0.1');
  process.stderr.write(
    `[shuba-control] role=http listening on 127.0.0.1:${port} (default harness: ${cfg.default.harness})\n`,
  );

  // Stop the spawned `graphify watch` child process on teardown so orphaned
  // watchers don't accumulate across sessions.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      try {
        graph.stopWatch();
      } catch {
        // best-effort teardown
      }
      process.exit(0);
    });
  }
  process.on('beforeExit', () => {
    try {
      graph.stopWatch();
    } catch {
      // best-effort teardown
    }
  });

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
