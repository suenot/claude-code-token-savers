import { fileURLToPath } from 'node:url';

const COMPACT_BIN = fileURLToPath(new URL('../bin/compact-interceptor.js', import.meta.url));

export const REGISTRY = {
  pxpipe: {
    id: 'pxpipe',
    bin: 'pxpipe',
    defaultPort: 47821,
    dialect: 'anthropic',
    terminal: false,
    readerConstraint: 'fable-only',
    healthPath: '/',
    build({ port, upstreamBase }) {
      return { args: [], env: { PORT: String(port), ANTHROPIC_UPSTREAM: upstreamBase } };
    },
  },
  headroom: {
    id: 'headroom',
    bin: 'headroom',
    defaultPort: 8787,
    dialect: 'anthropic',
    terminal: false,
    healthPath: '/health',
    build({ port, upstreamBase }) {
      return {
        args: ['proxy', '--port', String(port)],
        env: { ANTHROPIC_TARGET_API_URL: upstreamBase },
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
    build({ port, provider }) {
      return { args: [], env: { ROUTER_PORT: String(port), UPSTREAM_PROVIDER: provider } };
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
    build({ port, upstreamBase, config }) {
      const c = (config && config.compactRouter) || {};
      return {
        args: [COMPACT_BIN],
        env: {
          PORT: String(port),
          COMPACT_UPSTREAM: upstreamBase,
          COMPACT_MODEL: c.model || 'deepseek/deepseek-v4-flash',
          COMPACT_BASE_URL: c.baseUrl || 'https://openrouter.ai/api/v1',
          COMPACT_ENV_KEY: c.envKey || 'OPENROUTER_API_KEY',
        },
      };
    },
  },
};
