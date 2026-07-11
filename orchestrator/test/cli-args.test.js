import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitClaudeArgs } from '../src/cli.js';

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
