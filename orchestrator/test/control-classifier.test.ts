import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectHarnessModel, composeModel } from '../src/control/classifier.ts';

const cfg = {
  default: { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' },
  policy: [{ when: 'quick question', harness: 'gemini', model: 'gemini-flash' }],
};

test('explicit harness+model bypasses classifier (no fetch)', async () => {
  let called = false;
  const r = await selectHarnessModel({ task: 't', harness: 'claude', model: 'haiku' }, cfg as any,
    { fetchImpl: (async () => { called = true; return {} as any; }) });
  assert.deepEqual(r, { harness: 'claude', model: 'haiku' });
  assert.equal(called, false);
});

test('no hints → classifier result used', async () => {
  const fetchImpl = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"harness":"gemini","model":"gemini-flash"}' } }] }) })) as any;
  const r = await selectHarnessModel({ task: 'what is X' }, cfg as any, { fetchImpl, apiKey: 'k' });
  assert.deepEqual(r, { harness: 'gemini', model: 'gemini-flash' });
});

test('classifier error → default', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 500 })) as any;
  const r = await selectHarnessModel({ task: 'x' }, cfg as any, { fetchImpl, apiKey: 'k' });
  assert.deepEqual(r, { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' });
});

test('explicit harness only → model filled from default when no classifier', async () => {
  const r = await selectHarnessModel({ task: 'x', harness: 'qwen' }, { default: { harness: 'opencode', model: 'm0' } } as any, {});
  assert.equal(r.harness, 'qwen');
  assert.equal(r.model, 'm0');
});

test('composeModel joins provider/subprovider/model, dropping blanks', () => {
  assert.equal(composeModel({ provider: 'openrouter', subprovider: 'deepseek', model: 'a8e-1.0-pro' }), 'openrouter/deepseek/a8e-1.0-pro');
  assert.equal(composeModel({ provider: 'openrouter', model: 'a8e-1.0-pro' }), 'openrouter/a8e-1.0-pro');
  assert.equal(composeModel({ model: 'deepseek/deepseek-v4-flash' }), 'deepseek/deepseek-v4-flash');
  assert.equal(composeModel({ provider: '', subprovider: '', model: 'm' }), 'm');
});

test('selectHarnessModel composes the default target from provider/subprovider/model', async () => {
  const structured = {
    default: { harness: 'opencode', provider: 'openrouter', subprovider: 'deepseek', model: 'a8e-1.0-pro' },
  };
  // no harness/model on input, no policy -> falls back to composed default
  const r = await selectHarnessModel({ task: 'x' } as any, structured as any);
  assert.deepEqual(r, { harness: 'opencode', model: 'openrouter/deepseek/a8e-1.0-pro' });
});
