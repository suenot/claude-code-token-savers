import { fileURLToPath } from 'node:url';
import type { StageDescriptor, BuildContext, BuildResult } from './types.ts';

const COMPACT_BIN = fileURLToPath(new URL('../bin/compact-interceptor.ts', import.meta.url));
const WATCHDOG_BIN = fileURLToPath(new URL('../bin/context-watchdog.ts', import.meta.url));
const RATELIMIT_BIN = fileURLToPath(new URL('../bin/rate-limiter.ts', import.meta.url));
const CONTROL_BIN = fileURLToPath(new URL('../bin/shuba-control.ts', import.meta.url));

export const REGISTRY: Record<string, StageDescriptor> = {
  pxpipe: {
    id: 'pxpipe',
    bin: 'pxpipe',
    defaultPort: 47821,
    dialect: 'anthropic',
    terminal: false,
    readerConstraint: 'fable-only',
    healthPath: '/',
    build({ port, upstreamBase }: BuildContext): BuildResult {
      return { args: [], env: { PORT: String(port), ANTHROPIC_UPSTREAM: upstreamBase as string } };
    },
  },
  headroom: {
    id: 'headroom',
    bin: 'headroom',
    defaultPort: 8787,
    dialect: 'anthropic',
    terminal: false,
    healthPath: '/health',
    build({ port, upstreamBase }: BuildContext): BuildResult {
      return {
        args: ['proxy', '--port', String(port)],
        env: { ANTHROPIC_TARGET_API_URL: upstreamBase as string },
      };
    },
  },
  router: {
    id: 'router',
    bin: 'link-assistant-router',
    defaultPort: 8080,
    dialect: 'translates',
    terminal: true,
    requiresToken: true,
    healthPath: '/health',
    clientPathSuffix: '/api/latest/anthropic',
    build({ port, provider }: BuildContext): BuildResult {
      return { args: [], env: { ROUTER_PORT: String(port), UPSTREAM_PROVIDER: provider as string } };
    },
  },
  'compact-router': {
    id: 'compact-router',
    builtin: true,
    bin: process.execPath,
    defaultPort: 47850,
    dialect: 'anthropic',
    terminal: false,
    healthPath: '/health',
    build({ port, upstreamBase, config }: BuildContext): BuildResult {
      const c = (config && config.compactRouter) || {};
      return {
        args: [COMPACT_BIN],
        env: {
          PORT: String(port),
          COMPACT_UPSTREAM: upstreamBase as string,
          COMPACT_MODEL: c.model || 'deepseek/deepseek-v4-flash',
          COMPACT_BASE_URL: c.baseUrl || 'https://openrouter.ai/api/v1',
          COMPACT_ENV_KEY: c.envKey || 'OPENROUTER_API_KEY',
        },
      };
    },
  },
  'rate-limiter': {
    id: 'rate-limiter',
    builtin: true,
    bin: process.execPath,
    defaultPort: 47840,
    dialect: 'anthropic',
    terminal: false,
    healthPath: '/health',
    build({ port, upstreamBase, config }: BuildContext): BuildResult {
      const c = (config && config.rateLimiter) || {};
      return {
        args: [RATELIMIT_BIN],
        env: {
          PORT: String(port),
          RATELIMIT_UPSTREAM: upstreamBase as string,
          RATELIMIT_RPS: String(c.rps ?? 2),
          RATELIMIT_BURST: String(c.burst ?? 5),
          RATELIMIT_COOLDOWN_MS: String(c.cooldownMs ?? 5000),
        },
      };
    },
  },
  'context-watchdog': {
    id: 'context-watchdog',
    builtin: true,
    bin: process.execPath,
    defaultPort: 47851,
    dialect: 'anthropic',
    terminal: false,
    healthPath: '/health',
    build({ port, upstreamBase, config }: BuildContext): BuildResult {
      const c = (config && config.contextWatchdog) || {};
      return {
        args: [WATCHDOG_BIN],
        env: {
          PORT: String(port),
          WATCHDOG_UPSTREAM: upstreamBase as string,
          WATCHDOG_MODEL: c.model || 'deepseek/deepseek-v4-flash',
          WATCHDOG_BASE_URL: c.baseUrl || 'https://openrouter.ai/api/v1',
          WATCHDOG_ENV_KEY: c.envKey || 'OPENROUTER_API_KEY',
          WATCHDOG_THRESHOLD: String(c.thresholdTokens ?? 300000),
          WATCHDOG_TAIL_TURNS: String(c.tailTurns ?? 6),
        },
      };
    },
  },
  control: {
    id: 'control',
    builtin: true,
    bin: process.execPath,
    defaultPort: 47830,
    dialect: 'anthropic',
    terminal: false,
    healthPath: '/health',
    build({ port, config }: BuildContext): BuildResult {
      const delegate = config?.delegate ?? { default: { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' } };
      const graph = config?.graph ?? {};
      const compressors = config?.compressors ?? [];
      return {
        args: [CONTROL_BIN],
        env: {
          PORT: String(port),
          // The actual running chain (compressors), so the console probes only
          // live stages — not every registry entry (which would false-red `router`).
          CHAIN_JSON: JSON.stringify(compressors),
          // Marks this as the HTTP-serving sidecar instance (as opposed to
          // the stdio-MCP instance Claude Code spawns via .mcp.json, which
          // gets neither this env var nor PORT). See bin/shuba-control.ts.
          SHUBA_CONTROL_HTTP: '1',
          DELEGATE_JSON: JSON.stringify(delegate),
          GRAPH_JSON: JSON.stringify(graph),
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '',
        },
      };
    },
  },
};
