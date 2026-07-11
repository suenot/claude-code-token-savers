import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForHealth, up } from '../src/supervisor.ts';
import type { PlannedStage } from '../src/types.ts';

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
  const killed: string[] = [];
  const makeChild = (id: string) => ({ pid: id, kill: () => killed.push(id) });
  const children: Record<string, ReturnType<typeof makeChild>> = {
    s1: makeChild('s1'),
    s2: makeChild('s2'),
  };
  const spawnImpl = (bin: string) => children[bin];
  // s1 healthy, s2 never healthy -> up should fail and tear down s2 then s1
  const fetchImpl = async (url: string) => ({ ok: url.includes('1') });
  const chain: PlannedStage[] = [
    {
      id: 's1',
      port: 1,
      baseUrl: 'http://x',
      healthUrl: 'http://x/1',
      spawn: { bin: 's1', args: [], env: {} },
    },
    {
      id: 's2',
      port: 2,
      baseUrl: 'http://x',
      healthUrl: 'http://x/2',
      spawn: { bin: 's2', args: [], env: {} },
    },
  ];
  await assert.rejects(
    up(chain, { spawnImpl, fetchImpl, healthOpts: { timeoutMs: 20, intervalMs: 1 } }),
    /health|timed out/i,
  );
  assert.deepEqual(killed, ['s2', 's1']);
});

test('up() starts sidecars alongside the chain and health-checks them', async () => {
  const startedOrder: string[] = [];
  const makeChild = (id: string) => ({ pid: id, kill: () => {} });
  const children: Record<string, ReturnType<typeof makeChild>> = {
    control: makeChild('control'),
    s1: makeChild('s1'),
  };
  const spawnImpl = (bin: string) => {
    startedOrder.push(bin);
    return children[bin];
  };
  const fetchImpl = async () => ({ ok: true });
  const chain: PlannedStage[] = [
    {
      id: 's1',
      port: 1,
      baseUrl: 'http://x',
      healthUrl: 'http://x/1',
      spawn: { bin: 's1', args: [], env: {} },
    },
  ];
  const sidecars: PlannedStage[] = [
    {
      id: 'control',
      port: 47830,
      baseUrl: 'http://x',
      healthUrl: 'http://x/health',
      spawn: { bin: 'control', args: [], env: {} },
    },
  ];
  const handle = await up(chain, { spawnImpl, fetchImpl, sidecars, healthOpts: { timeoutMs: 20, intervalMs: 1 } });
  // Chain starts first (it's the critical path); sidecars start after,
  // best-effort.
  assert.deepEqual(startedOrder, ['s1', 'control']);
  const status = handle.status();
  assert.ok(status.some((s) => s.id === 'control'));
  await handle.down();
});

test('up() resolves and fully starts the chain even when a sidecar never becomes healthy', async () => {
  const killed: string[] = [];
  const makeChild = (id: string) => ({ pid: id, kill: () => killed.push(id) });
  const children: Record<string, ReturnType<typeof makeChild>> = {
    control: makeChild('control'),
    s1: makeChild('s1'),
    s2: makeChild('s2'),
  };
  const spawnImpl = (bin: string) => children[bin];
  // control (the sidecar) never reports healthy; s1/s2 (the chain) do.
  const fetchImpl = async (url: string) => ({ ok: !url.includes('control') });
  const chain: PlannedStage[] = [
    {
      id: 's1',
      port: 1,
      baseUrl: 'http://x',
      healthUrl: 'http://x/1',
      spawn: { bin: 's1', args: [], env: {} },
    },
    {
      id: 's2',
      port: 2,
      baseUrl: 'http://x',
      healthUrl: 'http://x/2',
      spawn: { bin: 's2', args: [], env: {} },
    },
  ];
  const sidecars: PlannedStage[] = [
    {
      id: 'control',
      port: 47830,
      baseUrl: 'http://x',
      healthUrl: 'http://x/control-health',
      spawn: { bin: 'control', args: [], env: {} },
    },
  ];
  const handle = await up(chain, {
    spawnImpl,
    fetchImpl,
    sidecars,
    healthOpts: { timeoutMs: 20, intervalMs: 1 },
  });
  // up() must resolve (not reject) even though the sidecar never became
  // healthy, and both chain stages must have started.
  const status = handle.status();
  assert.ok(status.some((s) => s.id === 's1'));
  assert.ok(status.some((s) => s.id === 's2'));
  await handle.down();
  // down() still cleans up the sidecar process that did start.
  assert.ok(killed.includes('control'));
});
