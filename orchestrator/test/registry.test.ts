import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY } from '../src/registry.ts';
import type { Config } from '../src/types.ts';

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
    config: { compactRouter: { model: 'a8e/a8e-1.0-pro' } } as Config,
  });
  assert.match(args[0], /bin\/compact-interceptor\.ts$/);
  assert.equal(env.PORT, '47850');
  assert.equal(env.COMPACT_UPSTREAM, 'http://127.0.0.1:8787');
  assert.equal(env.COMPACT_MODEL, 'a8e/a8e-1.0-pro');
  assert.equal(env.COMPACT_BASE_URL, 'http://localhost:8080/v1'); // default
  assert.equal(env.COMPACT_ENV_KEY, 'A8E_API_KEY'); // default
});

test('compact-router applies default model when config omits it', () => {
  const { env } = REGISTRY['compact-router'].build({ port: 1, upstreamBase: 'http://x' });
  assert.equal(env.COMPACT_MODEL, 'a8e/a8e-1.0-pro');
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
  assert.equal(env.WATCHDOG_MODEL, 'a8e/a8e-1.0-pro'); // default
});

test('context-watchdog applies defaults when config omits the block', () => {
  const { env } = REGISTRY['context-watchdog'].build({ port: 1, upstreamBase: 'http://x' });
  assert.equal(env.WATCHDOG_THRESHOLD, '300000');
  assert.equal(env.WATCHDOG_TAIL_TURNS, '6');
});

test('crush is a builtin node stage wired from config', () => {
  const d = REGISTRY.crush;
  assert.equal(d.builtin, true);
  assert.equal(d.terminal, false);
  assert.equal(d.healthPath, '/health');
  assert.equal(d.bin, process.execPath);
  const { args, env } = d.build({
    port: 47855, upstreamBase: 'http://127.0.0.1:8787',
    config: { crush: { threshold: 3000, budget: 1500 } } as Config,
  });
  assert.match(args[0], /bin\/crush\.ts$/);
  assert.equal(env.PORT, '47855');
  assert.equal(env.CRUSH_UPSTREAM, 'http://127.0.0.1:8787');
  assert.equal(env.CRUSH_THRESHOLD, '3000');
  assert.equal(env.CRUSH_BUDGET, '1500');
  assert.equal(env.CRUSH_ENABLED, undefined); // enabled by default, no override emitted
});

test('crush omits threshold/budget env when config omits them (server defaults apply)', () => {
  const { env } = REGISTRY.crush.build({ port: 47855, upstreamBase: 'http://x' });
  assert.equal(env.CRUSH_THRESHOLD, undefined);
  assert.equal(env.CRUSH_BUDGET, undefined);
});

test('crush emits CRUSH_ENABLED=false when disabled in config', () => {
  const { env } = REGISTRY.crush.build({
    port: 47855, upstreamBase: 'http://x', config: { crush: { enabled: false } } as Config,
  });
  assert.equal(env.CRUSH_ENABLED, 'false');
});

test('control descriptor is a builtin node sidecar wired from delegate config', () => {
  const d = REGISTRY.control;
  assert.equal(d.builtin, true);
  assert.equal(d.terminal, false);
  assert.equal(d.defaultPort, 47830);
  assert.equal(d.healthPath, '/health');
  assert.equal(d.bin, process.execPath);
  const { args, env } = d.build({
    port: 47830,
    config: { delegate: { default: { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' } } } as Config,
  });
  assert.match(args[0], /bin\/shuba-control\.ts$/);
  assert.equal(env.PORT, '47830');
  const parsed = JSON.parse(env.DELEGATE_JSON);
  assert.deepEqual(parsed.default, { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' });
});

test('control applies a default delegate config when config omits delegate', () => {
  const { env } = REGISTRY.control.build({ port: 47830 });
  const parsed = JSON.parse(env.DELEGATE_JSON);
  assert.equal(parsed.default, 'opencode/a8e/a8e-1.0-pro');
});
