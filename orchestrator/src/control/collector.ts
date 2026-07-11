import { readFile } from 'node:fs/promises';

export type ChainStage = { id: string; port: number; healthUrl: string };

export type ChainEntry = { id: string; port: number; healthy: boolean };

export type StatsResult = {
  pxpipe?: unknown;
  headroom?: unknown;
  totals: { saved_pct?: number; events?: number };
};

export type CollectorOpts = {
  pxpipeEventsPath?: string;
  headroomStatsUrl?: string;
  fetchImpl?: typeof fetch;
  stages?: ChainStage[];
};

export type Collector = {
  chain(): Promise<ChainEntry[]>;
  stats(): Promise<StatsResult>;
  recentRequests(limit?: number): Promise<unknown[]>;
};

// createCollector builds a runtime-agnostic (file + fetch only) collector
// that aggregates chain health (stage /health probes) and token-savings
// stats (pxpipe events.jsonl tail + headroom /stats), for the shuba
// management console's GET /api/chain and GET /api/stats endpoints. Every
// network/file operation is individually guarded: a missing file, an
// unreachable stage, or a failed fetch is omitted from the result rather
// than thrown.
export function createCollector(opts: CollectorOpts): Collector {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stages = opts.stages ?? [];

  async function chain(): Promise<ChainEntry[]> {
    return Promise.all(
      stages.map(async (stage) => {
        let healthy = false;
        try {
          const res = await fetchImpl(stage.healthUrl);
          healthy = res.ok;
        } catch {
          healthy = false;
        }
        return { id: stage.id, port: stage.port, healthy };
      }),
    );
  }

  async function readPxpipeEvents(): Promise<{ count: number; avgSavedPct?: number } | undefined> {
    if (!opts.pxpipeEventsPath) return undefined;
    let raw: string;
    try {
      raw = await readFile(opts.pxpipeEventsPath, 'utf8');
    } catch {
      return undefined;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const savedPcts: number[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { saved_pct?: unknown };
        if (typeof parsed.saved_pct === 'number') {
          savedPcts.push(parsed.saved_pct);
        }
      } catch {
        // Skip malformed lines rather than failing the whole tail.
      }
    }
    const avgSavedPct =
      savedPcts.length > 0 ? savedPcts.reduce((a, b) => a + b, 0) / savedPcts.length : undefined;
    return { count: lines.length, avgSavedPct };
  }

  async function readHeadroomStats(): Promise<unknown | undefined> {
    if (!opts.headroomStatsUrl) return undefined;
    try {
      const res = await fetchImpl(opts.headroomStatsUrl);
      if (!res.ok) return undefined;
      return await res.json();
    } catch {
      return undefined;
    }
  }

  async function stats(): Promise<StatsResult> {
    const [pxpipe, headroom] = await Promise.all([readPxpipeEvents(), readHeadroomStats()]);

    const totals: StatsResult['totals'] = {};
    if (pxpipe) {
      totals.events = pxpipe.count;
      if (pxpipe.avgSavedPct !== undefined) totals.saved_pct = pxpipe.avgSavedPct;
    }

    const result: StatsResult = { totals };
    if (pxpipe) result.pxpipe = pxpipe;
    if (headroom !== undefined) result.headroom = headroom;
    return result;
  }

  // recentRequests tails the pxpipe events.jsonl file (same source as
  // readPxpipeEvents) and returns the last `limit` parsed JSON entries,
  // newest-first. Each line is parsed defensively — a malformed line is
  // skipped rather than failing the whole tail. A missing file (or no
  // configured path) resolves to an empty array rather than throwing.
  async function recentRequests(limit = 100): Promise<unknown[]> {
    if (!opts.pxpipeEventsPath) return [];
    let raw: string;
    try {
      raw = await readFile(opts.pxpipeEventsPath, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const entries: unknown[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines rather than failing the whole tail.
      }
    }
    return entries.slice(-limit).reverse();
  }

  return { chain, stats, recentRequests };
}
