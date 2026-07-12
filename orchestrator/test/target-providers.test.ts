import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget } from '../src/control/target.ts';
import { resolveTarget } from '../src/control/providers.ts';
import { selectHarnessModel } from '../src/control/classifier.ts';
import { applyRoute } from '../src/router/apply.ts';

test('parseTarget detects a leading harness only when known', () => {
  const t = parseTarget('opencode/openrouter/deepseek/a8e-1.0-pro');
  assert.equal(t.harness, 'opencode');
  assert.equal(t.provider, 'openrouter');
  assert.equal(t.subprovider, 'deepseek');
  assert.equal(t.model, 'a8e-1.0-pro');
  assert.equal(t.modelPath, 'openrouter/deepseek/a8e-1.0-pro');

  const noHarness = parseTarget('a8e/a8e-1.0-pro');
  assert.equal(noHarness.harness, undefined);
  assert.equal(noHarness.provider, 'a8e');
  assert.equal(noHarness.model, 'a8e-1.0-pro');
  assert.equal(noHarness.modelPath, 'a8e/a8e-1.0-pro');

  const bare = parseTarget('claude-haiku-4-5');
  assert.equal(bare.provider, undefined);
  assert.equal(bare.model, 'claude-haiku-4-5');
});

test('resolveTarget maps a known provider to endpoint; model form is per-provider', () => {
  // a8e is a local router -> keep the full provider/model path
  const a8e = resolveTarget('a8e/a8e-1.0-pro');
  assert.equal(a8e.model, 'a8e/a8e-1.0-pro');
  assert.equal(a8e.baseUrl, 'http://localhost:8080/v1');
  assert.equal(a8e.envKey, 'A8E_API_KEY');

  // openrouter -> drop its own prefix, keep subprovider/model
  const or = resolveTarget('openrouter/deepseek/a8e-1.0-pro');
  assert.equal(or.model, 'deepseek/a8e-1.0-pro');
  assert.equal(or.baseUrl, 'https://openrouter.ai/api/v1');

  // native API -> bare model
  const an = resolveTarget('anthropic/claude-opus-4-8');
  assert.equal(an.model, 'claude-opus-4-8');
  assert.equal(an.baseUrl, 'https://api.anthropic.com');

  // unknown provider -> passthrough, no endpoint override
  const unknown = resolveTarget('someprov/model-x');
  assert.equal(unknown.model, 'someprov/model-x');
  assert.equal(unknown.baseUrl, undefined);
});

test('selectHarnessModel resolves a single-string default target', async () => {
  const cfg: any = { default: 'opencode/a8e/a8e-1.0-pro' };
  const r = await selectHarnessModel({ task: 'x' } as any, cfg);
  assert.deepEqual(r, { harness: 'opencode', model: 'a8e/a8e-1.0-pro' });
});

test('applyRoute resolves a route target to model + upstream', () => {
  const req = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] };
  const { body, upstream, stats } = applyRoute(req, 'background', { background: { model: 'a8e/a8e-1.0-pro' } });
  assert.equal(body.model, 'a8e/a8e-1.0-pro');
  assert.equal(stats.routedModel, 'a8e/a8e-1.0-pro');
  assert.deepEqual(upstream, {
    baseUrl: 'http://localhost:8080/v1',
    envKey: 'A8E_API_KEY',
    dialect: 'openai',
    tools: 'block',
  });
});
