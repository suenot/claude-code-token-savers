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
};
