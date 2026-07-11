import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector } from '../src/control/collector.ts';
import { appendReqLog } from '../src/control/reqlog.ts';

function fetchStub(map: Record<string, { ok: boolean; body?: unknown } | 'throw'>): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const entry = map[url];
    if (entry === 'throw' || entry === undefined) {
      throw new Error(`network error: ${url}`);
    }
    return {
      ok: entry.ok,
      json: async () => entry.body ?? {},
    } as Response;
  }) as typeof fetch;
}

test('chain() marks a healthy stage healthy and a down stage unhealthy', async () => {
  const fetchImpl = fetchStub({
    'http://a/health': { ok: true },
    'http://b/health': 'throw',
  });
  const collector = createCollector({
    fetchImpl,
    stages: [
      { id: 'a', port: 4001, healthUrl: 'http://a/health' },
      { id: 'b', port: 4002, healthUrl: 'http://b/health' },
    ],
  });
  const chain = await collector.chain();
  assert.deepEqual(chain, [
    { id: 'a', port: 4001, healthy: true },
    { id: 'b', port: 4002, healthy: false },
  ]);
});

test('chain() marks a stage unhealthy when the response is not ok', async () => {
  const fetchImpl = fetchStub({ 'http://a/health': { ok: false } });
  const collector = createCollector({
    fetchImpl,
    stages: [{ id: 'a', port: 4001, healthUrl: 'http://a/health' }],
  });
  const chain = await collector.chain();
  assert.equal(chain[0]!.healthy, false);
});

test('chain() with no stages returns an empty array', async () => {
  const collector = createCollector({});
  assert.deepEqual(await collector.chain(), []);
});

test('stats() never throws when nothing is configured', async () => {
  const collector = createCollector({});
  const stats = await collector.stats();
  assert.deepEqual(stats.totals, {});
  assert.equal(stats.headroom, undefined);
});

test('stats() merges headroom stats when a fetchImpl + url resolve', async () => {
  const fetchImpl = fetchStub({
    'http://headroom/stats': { ok: true, body: { saved_pct: 42 } },
  });
  const collector = createCollector({
    fetchImpl,
    headroomStatsUrl: 'http://headroom/stats',
  });
  const stats = await collector.stats();
  assert.deepEqual(stats.headroom, { saved_pct: 42 });
});

test('stats() omits headroom when the fetch fails', async () => {
  const fetchImpl = fetchStub({ 'http://headroom/stats': 'throw' });
  const collector = createCollector({ fetchImpl, headroomStatsUrl: 'http://headroom/stats' });
  const stats = await collector.stats();
  assert.equal(stats.headroom, undefined);
});

test('hopLog() returns per-hop reqlog entries, newest-first, tagged with source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shuba-collector-hoplog-'));
  const reqlogPath = join(dir, 'requests.jsonl');
  try {
    appendReqLog(
      {
        ts: '2024-01-02T00:00:00.000Z',
        stage: 'rate-limiter',
        method: 'POST',
        path: '/v1/messages',
        action: 'forward',
        upstreamStatus: 200,
      },
      { path: reqlogPath },
    );
    appendReqLog(
      {
        ts: '2024-01-03T00:00:00.000Z',
        stage: 'compact-router',
        method: 'POST',
        path: '/v1/messages',
        action: 'intercept',
      },
      { path: reqlogPath },
    );

    const prevReqLog = process.env.SHUBA_REQLOG;
    process.env.SHUBA_REQLOG = reqlogPath;
    try {
      const collector = createCollector({});
      const merged = (await collector.hopLog(10)) as Array<Record<string, unknown>>;
      const rateLimiterEntry = merged.find((e) => e.stage === 'rate-limiter');
      const compactEntry = merged.find((e) => e.stage === 'compact-router');
      assert.equal(rateLimiterEntry?.source, 'rate-limiter');
      assert.equal(compactEntry?.source, 'compact-router');
      // newest-first by timestamp: compact-router (01-03) before rate-limiter (01-02)
      const order = merged.map((e) => e.source);
      assert.ok(order.indexOf('compact-router') < order.indexOf('rate-limiter'));
    } finally {
      if (prevReqLog === undefined) delete process.env.SHUBA_REQLOG;
      else process.env.SHUBA_REQLOG = prevReqLog;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
