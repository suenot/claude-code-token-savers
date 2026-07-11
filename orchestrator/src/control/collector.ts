import { open, stat } from 'node:fs/promises';

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
// Maximum number of bytes read from the tail of events.jsonl. Both stats()
// and recentRequests() poll this file every ~2s from up to 3 console views;
// reading the whole file on every poll is O(filesize) and grows unbounded as
// the file grows. Capping the read keeps each poll O(1) relative to file
// size, at the cost of stats().totals.events reflecting only "recent events
// in the last 256KB" rather than a lifetime count — acceptable for a
// dashboard.
const TAIL_CAP_BYTES = 256 * 1024;

// readTailLines reads at most the last TAIL_CAP_BYTES of `path`, splits it
// into non-empty lines, and drops a possibly-truncated first line (the read
// may have started mid-line when the file is larger than the cap). For files
// smaller than the cap this reads the whole file, so behavior is unchanged
// (aside from the truncated-first-line handling, which is a no-op when the
// read started at offset 0). Returns `undefined` (not an empty array) when
// the file is missing/unreadable, so callers can distinguish "no file" from
// "file exists but is empty" the same way the previous whole-file readFile
// did via its catch block.
async function readTailLines(path: string): Promise<string[] | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const info = await stat(path);
    const size = info.size;
    const readLen = Math.min(size, TAIL_CAP_BYTES);
    const start = size - readLen;
    const buffer = Buffer.alloc(readLen);
    if (readLen > 0) {
      await handle.read(buffer, 0, readLen, start);
    }
    let raw = buffer.toString('utf8');
    if (start > 0) {
      // We may have started mid-line; drop the (possibly partial) first
      // line since we can't tell whether it's complete.
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
    }
    return raw.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

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
    const lines = await readTailLines(opts.pxpipeEventsPath);
    if (lines === undefined) return undefined;
    // Note: `count` (and thus stats().totals.events) reflects only the
    // events found within the last TAIL_CAP_BYTES of the file, not a
    // lifetime total — acceptable for the dashboard's purposes.
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
    const lines = await readTailLines(opts.pxpipeEventsPath);
    if (lines === undefined) return [];
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
