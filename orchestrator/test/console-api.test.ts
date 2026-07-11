import { test, expect, describe, afterEach } from 'bun:test';
import {
  getChain,
  getStats,
  getJobs,
  getJob,
  getJobResult,
  delegate,
  getHarnesses,
  getGraph,
  graphQuery,
} from '../console/src/api.ts';

type Call = { input: RequestInfo | URL; init: RequestInit | undefined };

function stubFetch(response: unknown, ok = true, status = 200): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  }) as typeof fetch;
  // Force `ok` even for non-2xx status codes if requested via the `ok` param,
  // since the real Response computes `ok` from status.
  if (!ok) {
    // Response with status >= 400 already has ok === false; nothing to patch.
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('console api client', () => {
  afterEach(() => {
    // no-op; each test restores its own stub in a finally block
  });

  test('delegate() POSTs /api/delegate with JSON content-type and body', async () => {
    const { calls, restore } = stubFetch({ job_id: 'job_1', harness_chosen: 'claude', model_chosen: 'sonnet' });
    try {
      const result = await delegate({ task: 't' });
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.input).toBe('/api/delegate');
      expect(call.init?.method).toBe('POST');
      const headers = new Headers(call.init?.headers);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(call.init?.body).toBe(JSON.stringify({ task: 't' }));
      expect(result).toEqual({ job_id: 'job_1', harness_chosen: 'claude', model_chosen: 'sonnet' });
    } finally {
      restore();
    }
  });

  test('getChain() GETs /api/chain and returns parsed JSON', async () => {
    const { calls, restore } = stubFetch([{ id: 'gate', port: 8788, healthy: true }]);
    try {
      const result = await getChain();
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.input).toBe('/api/chain');
      expect(call.init?.method ?? 'GET').toBe('GET');
      expect(result).toEqual([{ id: 'gate', port: 8788, healthy: true }]);
    } finally {
      restore();
    }
  });

  test('graphQuery() POSTs /api/graph/query with JSON content-type', async () => {
    const { calls, restore } = stubFetch({ ok: true, result: 'answer' });
    try {
      const result = await graphQuery('X');
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.input).toBe('/api/graph/query');
      expect(call.init?.method).toBe('POST');
      const headers = new Headers(call.init?.headers);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(call.init?.body).toBe(JSON.stringify({ query: 'X' }));
      expect(result).toEqual({ ok: true, result: 'answer' });
    } finally {
      restore();
    }
  });

  test('getStats() GETs /api/stats', async () => {
    const { calls, restore } = stubFetch({ totals: { events: 3 } });
    try {
      const result = await getStats();
      expect(calls[0]!.input).toBe('/api/stats');
      expect(result).toEqual({ totals: { events: 3 } });
    } finally {
      restore();
    }
  });

  test('getJobs() GETs /api/jobs', async () => {
    const { calls, restore } = stubFetch([]);
    try {
      await getJobs();
      expect(calls[0]!.input).toBe('/api/jobs');
    } finally {
      restore();
    }
  });

  test('getJob(id) GETs /api/jobs/:id', async () => {
    const { calls, restore } = stubFetch({ status: 'running' });
    try {
      await getJob('job_1');
      expect(calls[0]!.input).toBe('/api/jobs/job_1');
    } finally {
      restore();
    }
  });

  test('getJobResult(id) GETs /api/jobs/:id/result', async () => {
    const { calls, restore } = stubFetch({ status: 'done', result: 'ok', exit_code: 0, log_path: '/tmp/x.log' });
    try {
      await getJobResult('job_1');
      expect(calls[0]!.input).toBe('/api/jobs/job_1/result');
    } finally {
      restore();
    }
  });

  test('getHarnesses() GETs /api/harnesses', async () => {
    const { calls, restore } = stubFetch([{ id: 'claude', bin: 'claude', installed: true }]);
    try {
      await getHarnesses();
      expect(calls[0]!.input).toBe('/api/harnesses');
    } finally {
      restore();
    }
  });

  test('getGraph() GETs /api/graph', async () => {
    const { calls, restore } = stubFetch({ built: true, path: '/x', node_count: 1, last_built: null, watching: false });
    try {
      await getGraph();
      expect(calls[0]!.input).toBe('/api/graph');
    } finally {
      restore();
    }
  });

  test('throws on non-ok response', async () => {
    const { restore } = stubFetch({ error: 'nope' }, false, 500);
    try {
      await expect(getChain()).rejects.toThrow();
    } finally {
      restore();
    }
  });
});
