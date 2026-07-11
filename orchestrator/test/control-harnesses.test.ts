import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, detectHarnesses } from '../src/control/harnesses.ts';

test('claude adapter injects --dangerously-skip-permissions and model', () => {
  const a = HARNESSES['claude'];
  const args = a.buildArgs('fix bug', { model: 'haiku' });
  assert.deepEqual(args, ['--model', 'haiku', '-p', 'fix bug', '--dangerously-skip-permissions']);
});

test('claude adapter omits --dangerously-skip-permissions when SHUBA_SKIP_PERMISSIONS=0', () => {
  const prev = process.env.SHUBA_SKIP_PERMISSIONS;
  try {
    process.env.SHUBA_SKIP_PERMISSIONS = '0';
    const a = HARNESSES['claude'];
    const args = a.buildArgs('fix bug', { model: 'haiku' });
    assert.deepEqual(args, ['--model', 'haiku', '-p', 'fix bug']);
  } finally {
    if (prev === undefined) {
      delete process.env.SHUBA_SKIP_PERMISSIONS;
    } else {
      process.env.SHUBA_SKIP_PERMISSIONS = prev;
    }
  }
});

test('gemini adapter omits -m when no model', () => {
  const args = HARNESSES['gemini'].buildArgs('summarize', {});
  assert.deepEqual(args, ['-p', 'summarize']);
});

test('opencode adapter uses run -m --format json', () => {
  const args = HARNESSES['opencode'].buildArgs('refactor', { model: 'deepseek/deepseek-v4-flash' });
  assert.deepEqual(args, ['run', '-m', 'deepseek/deepseek-v4-flash', '--format', 'json', 'refactor']);
});

test('extractResult trims plain stdout', () => {
  assert.equal(HARNESSES['gemini'].extractResult('  answer\n'), 'answer');
});

test('detectHarnesses marks installed via injected which', () => {
  const rows = detectHarnesses((bin) => bin === 'gemini' || bin === 'claude');
  const byId = Object.fromEntries(rows.map(r => [r.id, r.installed]));
  assert.equal(byId['gemini'], true);
  assert.equal(byId['claude'], true);
  assert.equal(byId['opencode'], false);
});
