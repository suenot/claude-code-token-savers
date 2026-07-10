import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../src/registry.js';

test('pxpipe descriptor wires PORT and ANTHROPIC_UPSTREAM', () => {
  const d = REGISTRY.pxpipe;
  assert.equal(d.bin, 'pxpipe');
  assert.equal(d.terminal, false);
  assert.equal(d.readerConstraint, 'fable-only');
  assert.equal(d.healthPath, '/');
  const { env } = d.build({ port: 47821, upstreamBase: 'http://127.0.0.1:8787' });
  assert.equal(env.PORT, '47821');
  assert.equal(env.ANTHROPIC_UPSTREAM, 'http://127.0.0.1:8787');
});

test('headroom descriptor wires --port and ANTHROPIC_TARGET_API_URL', () => {
  const d = REGISTRY.headroom;
  assert.equal(d.healthPath, '/stats');
  const { args, env } = d.build({ port: 8787, upstreamBase: 'https://api.anthropic.com' });
  assert.deepEqual(args, ['proxy', '--port', '8787']);
  assert.equal(env.ANTHROPIC_TARGET_API_URL, 'https://api.anthropic.com');
});

test('router descriptor is terminal, wires ROUTER_PORT + UPSTREAM_PROVIDER, has path suffix', () => {
  const d = REGISTRY.router;
  assert.equal(d.terminal, true);
  assert.equal(d.requiresToken, true);
  assert.equal(d.healthPath, '/health');
  assert.equal(d.clientPathSuffix, '/api/latest/anthropic');
  const { env } = d.build({ port: 8080, provider: 'codex' });
  assert.equal(env.ROUTER_PORT, '8080');
  assert.equal(env.UPSTREAM_PROVIDER, 'codex');
});
