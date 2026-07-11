import { readReqLog } from './reqlog.ts';

export type ChainStage = { id: string; port: number; healthUrl: string };

export type ChainEntry = { id: string; port: number; healthy: boolean };

export type StatsResult = {
  headroom?: unknown;
  totals: { saved_pct?: number; events?: number };
};

export type CollectorOpts = {
  headroomStatsUrl?: string;
  fetchImpl?: typeof fetch;
  stages?: ChainStage[];
};

export type Collector = {
  chain(): Promise<ChainEntry[]>;
  stats(): Promise<StatsResult>;
  hopLog(limit?: number): Promise<unknown[]>;
};

// createCollector builds a runtime-agnostic (fetch only) collector that
// aggregates chain health (stage /health probes) and token-savings stats
// (headroom /stats), for the shuba management console's GET /api/chain and
// GET /api/stats endpoints. Every network operation is individually
// guarded: an unreachable stage or a failed fetch is omitted from the
// result rather than thrown.
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
    const headroom = await readHeadroomStats();
    const totals: StatsResult['totals'] = {};
    const result: StatsResult = { totals };
    if (headroom !== undefined) result.headroom = headroom;
    return result;
  }

  // hopLog returns the per-hop reqlog entries (src/control/reqlog.ts),
  // newest-first, tagged with the entry's own `stage` (e.g.
  // 'compact-router', 'context-watchdog', 'rate-limiter') as `source`, for
  // the console's "what actually went out" view.
  function extractTimestampMs(entry: unknown): number {
    if (!entry || typeof entry !== 'object') return 0;
    const rec = entry as Record<string, unknown>;
    const candidate = rec.ts ?? rec.timestamp;
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  }

  async function hopLog(limit = 100): Promise<unknown[]> {
    const tagged = readReqLog({ limit }).map((e) => ({ ...e, source: e.stage }));
    tagged.sort((a, b) => extractTimestampMs(b) - extractTimestampMs(a));
    return tagged.slice(0, limit);
  }

  return { chain, stats, hopLog };
}
