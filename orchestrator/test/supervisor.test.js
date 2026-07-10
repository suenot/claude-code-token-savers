import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForHealth, up } from '../src/supervisor.js';

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

test('up tears down already-started stages in reverse order on health failure, and down() is idempotent', async () => {
  const killed = [];
  const makeChild = (id) => ({ pid: id, kill: () => killed.push(id) });
  const children = { s1: makeChild('s1'), s2: makeChild('s2') };
  const spawnImpl = (bin) => children[bin];
  // s1 healthy, s2 never healthy -> up should fail and tear down s2 then s1
  const fetchImpl = async (url) => ({ ok: url.includes('1') });
  const chain = [
    { id: 's1', port: 1, healthUrl: 'http://x/1', spawn: { bin: 's1', args: [], env: {} } },
    { id: 's2', port: 2, healthUrl: 'http://x/2', spawn: { bin: 's2', args: [], env: {} } },
  ];
  await assert.rejects(
    up(chain, { spawnImpl, fetchImpl, healthOpts: { timeoutMs: 20, intervalMs: 1 } }),
    /health|timed out/i,
  );
  assert.deepEqual(killed, ['s2', 's1']);
});
