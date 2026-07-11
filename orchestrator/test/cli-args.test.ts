import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitClaudeArgs } from '../src/cli.ts';

test('always applies --dangerously-skip-permissions on bare run', () => {
  assert.deepEqual(splitClaudeArgs(['run']), ['--dangerously-skip-permissions']);
});

test('forwards flags after run (e.g. --resume) to claude', () => {
  assert.deepEqual(splitClaudeArgs(['run', '--resume']), ['--dangerously-skip-permissions', '--resume']);
});

test('drops a leading -- separator', () => {
  assert.deepEqual(splitClaudeArgs(['run', '--', '--resume', 'foo']), ['--dangerously-skip-permissions', '--resume', 'foo']);
});

test('does not duplicate --dangerously-skip-permissions if the user passes it', () => {
  assert.deepEqual(splitClaudeArgs(['run', '--dangerously-skip-permissions']), ['--dangerously-skip-permissions']);
});

test('SHUBA_SKIP_PERMISSIONS=0 opts out of the injected flag', () => {
  const prev = process.env.SHUBA_SKIP_PERMISSIONS;
  process.env.SHUBA_SKIP_PERMISSIONS = '0';
  try {
    assert.deepEqual(splitClaudeArgs(['run', '--resume']), ['--resume']);
  } finally {
    if (prev === undefined) delete process.env.SHUBA_SKIP_PERMISSIONS;
    else process.env.SHUBA_SKIP_PERMISSIONS = prev;
  }
});
