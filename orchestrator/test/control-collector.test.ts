import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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

test('stats() counts events from a pxpipe events.jsonl file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shuba-collector-'));
  const eventsPath = join(dir, 'events.jsonl');
  try {
    await writeFile(
      eventsPath,
      [
        JSON.stringify({ saved_pct: 50 }),
        JSON.stringify({ saved_pct: 70 }),
        JSON.stringify({ saved_pct: 60 }),
      ].join('\n') + '\n',
    );
    const collector = createCollector({ pxpipeEventsPath: eventsPath });
    const stats = await collector.stats();
    assert.equal(stats.totals.events, 3);
    assert.equal(stats.totals.saved_pct, 60);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stats() omits totals fields and does not throw when the events file is missing', async () => {
  const collector = createCollector({ pxpipeEventsPath: '/nonexistent/path/events.jsonl' });
  const stats = await collector.stats();
  assert.equal(stats.totals.events, undefined);
  assert.equal(stats.totals.saved_pct, undefined);
  assert.equal(stats.pxpipe, undefined);
});

test('stats() never throws when nothing is configured', async () => {
  const collector = createCollector({});
  const stats = await collector.stats();
  assert.deepEqual(stats.totals, {});
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

test('recentRequests() returns the last N parsed entries newest-first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shuba-collector-'));
  const eventsPath = join(dir, 'events.jsonl');
  try {
    await writeFile(
      eventsPath,
      [
        JSON.stringify({ id: 1 }),
        JSON.stringify({ id: 2 }),
        JSON.stringify({ id: 3 }),
        JSON.stringify({ id: 4 }),
        JSON.stringify({ id: 5 }),
      ].join('\n') + '\n',
    );
    const collector = createCollector({ pxpipeEventsPath: eventsPath });
    const recent = await collector.recentRequests(3);
    assert.deepEqual(recent, [{ id: 5 }, { id: 4 }, { id: 3 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recentRequests() returns an empty array and does not throw when the file is missing', async () => {
  const collector = createCollector({ pxpipeEventsPath: '/nonexistent/path/events.jsonl' });
  assert.deepEqual(await collector.recentRequests(3), []);
});

test('recentRequests() returns an empty array when nothing is configured', async () => {
  const collector = createCollector({});
  assert.deepEqual(await collector.recentRequests(), []);
});

test('recentRequests() returns the last entries even when the file is larger than the tail cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shuba-collector-'));
  const eventsPath = join(dir, 'events.jsonl');
  try {
    // Pad each line so the file exceeds the collector's ~256KB tail-read
    // cap; the last few lines must still come back correctly even though
    // the collector only reads the final slice of the file.
    const filler = 'x'.repeat(500);
    const lines: string[] = [];
    let totalBytes = 0;
    let id = 0;
    const targetBytes = 300 * 1024;
    while (totalBytes < targetBytes) {
      id += 1;
      const line = JSON.stringify({ id, filler });
      lines.push(line);
      totalBytes += line.length + 1;
    }
    await writeFile(eventsPath, lines.join('\n') + '\n');
    const collector = createCollector({ pxpipeEventsPath: eventsPath });
    const recent = await collector.recentRequests(3);
    assert.deepEqual(
      recent,
      [lines[lines.length - 1]!, lines[lines.length - 2]!, lines[lines.length - 3]!].map((l) => JSON.parse(l)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stats() counts only recent events within the tail cap for a file larger than the cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shuba-collector-'));
  const eventsPath = join(dir, 'events.jsonl');
  try {
    const filler = 'x'.repeat(500);
    const lines: string[] = [];
    let totalBytes = 0;
    let count = 0;
    const targetBytes = 300 * 1024;
    while (totalBytes < targetBytes) {
      count += 1;
      const line = JSON.stringify({ saved_pct: 50, filler });
      lines.push(line);
      totalBytes += line.length + 1;
    }
    await writeFile(eventsPath, lines.join('\n') + '\n');
    const collector = createCollector({ pxpipeEventsPath: eventsPath });
    const stats = await collector.stats();
    assert.ok(typeof stats.totals.events === 'number');
    assert.ok(stats.totals.events! > 0);
    assert.ok(stats.totals.events! < count, 'tail-capped count should be less than the full file line count');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hopLog() merges pxpipe entries and per-hop reqlog entries, tagged with source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shuba-collector-hoplog-'));
  const eventsPath = join(dir, 'events.jsonl');
  const reqlogPath = join(dir, 'requests.jsonl');
  try {
    await writeFile(
      eventsPath,
      [JSON.stringify({ timestamp: '2024-01-01T00:00:00.000Z', kind: 'pxpipe-entry' })].join('\n') + '\n',
    );
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
      const collector = createCollector({ pxpipeEventsPath: eventsPath });
      const merged = await collector.hopLog(10) as Array<Record<string, unknown>>;
      const pxpipeEntry = merged.find((e) => e.kind === 'pxpipe-entry');
      const rateLimiterEntry = merged.find((e) => e.stage === 'rate-limiter');
      const compactEntry = merged.find((e) => e.stage === 'compact-router');
      assert.equal(pxpipeEntry?.source, 'pxpipe');
      assert.equal(rateLimiterEntry?.source, 'rate-limiter');
      assert.equal(compactEntry?.source, 'compact-router');
      // newest-first by timestamp: compact-router (01-03) before rate-limiter (01-02) before pxpipe (01-01)
      const order = merged.map((e) => e.source);
      assert.ok(order.indexOf('compact-router') < order.indexOf('rate-limiter'));
      assert.ok(order.indexOf('rate-limiter') < order.indexOf('pxpipe'));
    } finally {
      if (prevReqLog === undefined) delete process.env.SHUBA_REQLOG;
      else process.env.SHUBA_REQLOG = prevReqLog;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recentRequests() skips a malformed line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shuba-collector-'));
  const eventsPath = join(dir, 'events.jsonl');
  try {
    await writeFile(
      eventsPath,
      [JSON.stringify({ id: 1 }), 'not json', JSON.stringify({ id: 2 })].join('\n') + '\n',
    );
    const collector = createCollector({ pxpipeEventsPath: eventsPath });
    const recent = await collector.recentRequests(10);
    assert.deepEqual(recent, [{ id: 2 }, { id: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
