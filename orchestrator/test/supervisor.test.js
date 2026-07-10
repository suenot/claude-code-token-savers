import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForHealth } from '../src/supervisor.js';

test('waitForHealth resolves once fetch returns ok', async () => {
  let calls = 0;
  const fetchImpl = async () => ({ ok: ++calls >= 3 });
  await waitForHealth('http://x/health', {
    timeoutMs: 5000,
    intervalMs: 1,
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(calls, 3);
});

test('waitForHealth rejects after timeout', async () => {
  let t = 0;
  const fetchImpl = async () => {
    throw new Error('conn refused');
  };
  await assert.rejects(
    waitForHealth('http://x/health', {
      timeoutMs: 10,
      intervalMs: 1,
      fetchImpl,
      now: () => (t += 5),
      sleep: async () => {},
    }),
    /timed out|health/i,
  );
});
