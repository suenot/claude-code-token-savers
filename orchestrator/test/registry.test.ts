import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../src/registry.ts';
import type { Config } from '../src/types.ts';

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
  assert.equal(d.healthPath, '/health');
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

test('compact-router is a builtin node stage wired from config', () => {
  const d = REGISTRY['compact-router'];
  assert.equal(d.builtin, true);
  assert.equal(d.terminal, false);
  assert.equal(d.healthPath, '/health');
  assert.equal(d.bin, process.execPath);
  const { args, env } = d.build({
    port: 47850, upstreamBase: 'http://127.0.0.1:8787',
    config: { compactRouter: { model: 'deepseek/deepseek-v4-flash' } } as Config,
  });
  assert.match(args[0], /bin\/compact-interceptor\.ts$/);
  assert.equal(env.PORT, '47850');
  assert.equal(env.COMPACT_UPSTREAM, 'http://127.0.0.1:8787');
  assert.equal(env.COMPACT_MODEL, 'deepseek/deepseek-v4-flash');
  assert.equal(env.COMPACT_BASE_URL, 'https://openrouter.ai/api/v1'); // default
  assert.equal(env.COMPACT_ENV_KEY, 'OPENROUTER_API_KEY'); // default
});

test('compact-router applies default model when config omits it', () => {
  const { env } = REGISTRY['compact-router'].build({ port: 1, upstreamBase: 'http://x' });
  assert.equal(env.COMPACT_MODEL, 'deepseek/deepseek-v4-flash');
});

test('context-watchdog builtin wires threshold/tail/model from config', () => {
  const d = REGISTRY['context-watchdog'];
  assert.equal(d.builtin, true);
  assert.equal(d.terminal, false);
  assert.equal(d.healthPath, '/health');
  assert.equal(d.bin, process.execPath);
  const { args, env } = d.build({
    port: 47851, upstreamBase: 'http://127.0.0.1:8787',
    config: { contextWatchdog: { thresholdTokens: 250000, tailTurns: 8 } } as Config,
  });
  assert.match(args[0], /bin\/context-watchdog\.ts$/);
  assert.equal(env.PORT, '47851');
  assert.equal(env.WATCHDOG_UPSTREAM, 'http://127.0.0.1:8787');
  assert.equal(env.WATCHDOG_THRESHOLD, '250000');
  assert.equal(env.WATCHDOG_TAIL_TURNS, '8');
  assert.equal(env.WATCHDOG_MODEL, 'deepseek/deepseek-v4-flash'); // default
});

test('context-watchdog applies defaults when config omits the block', () => {
  const { env } = REGISTRY['context-watchdog'].build({ port: 1, upstreamBase: 'http://x' });
  assert.equal(env.WATCHDOG_THRESHOLD, '300000');
  assert.equal(env.WATCHDOG_TAIL_TURNS, '6');
});
