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

createControlHttp(engine).listen(port, '127.0.0.1');
void connectStdio(createMcpServer(engine));

process.stderr.write(
  `[shuba-control] listening on 127.0.0.1:${port} + stdio MCP (default harness: ${cfg.default.harness})\n`,
);
