import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// Per-hop request log: every proxy stage in the shuba chain (compact-router,
// context-watchdog, rate-limiter) appends one line per /v1/messages request
// it handles, so the management console can reconstruct "what actually left
// this machine towards Anthropic" and spot request amplification. This is a
// diagnostic side-channel — every function here is designed to never throw,
// so a logging bug can never affect the proxy's actual response path.

export type ReqLogEntry = {
  ts: string; // ISO
  stage: string; // 'compact-router' | 'context-watchdog' | 'rate-limiter' | 'dedup'
  method: string;
  path: string;
  model?: string;
  maxTokens?: number;
  action: 'forward' | 'intercept' | 'summarize' | 'passthrough' | 'dedup';
  upstreamStatus?: number;
  durationMs?: number;
  bodySha?: string; // short sha of raw body
  preview?: string; // <=80 chars of first user message content
  // Savings telemetry (WS3): estimated request tokens before/after this stage's
  // transform. `tokensSaved` is `tokensIn - tokensOut` and is only meaningful on
  // an intercept/summarize/dedup action where the stage actually rewrote the body.
  tokensIn?: number;
  tokensOut?: number;
  tokensSaved?: number;
  // Real usage observed on the upstream response (parsed best-effort by
  // parseUsage). Only the terminal stage that talks to the real API sees these,
  // so they appear on at most one entry per request — no double counting.
  // `cacheRead`/`cacheWrite` are Anthropic's cache_read_input_tokens /
  // cache_creation_input_tokens; body rewrites in earlier stages can break the
  // cache prefix and show up here as a collapsed cacheRead.
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type SavingsSummary = {
  totalIn: number;
  totalOut: number;
  totalSaved: number;
  requests: number; // entries carrying token telemetry
  byStage: Record<string, { in: number; out: number; saved: number; requests: number }>;
  byModel: Record<string, { in: number; out: number; saved: number; requests: number }>;
};

const DEFAULT_MAX_APPEND_BYTES = 5_000_000;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const DEFAULT_READ_LIMIT = 200;

function defaultLogPath(): string {
  return process.env.SHUBA_REQLOG ?? join(homedir(), '.shuba', 'requests.jsonl');
}

function resolveAppendPath(opts?: { path?: string }): string {
  return opts?.path ?? defaultLogPath();
}

// Truncate `content` (already-read full file text) to roughly its last half
// by bytes, keeping only whole lines (dropping a possibly-truncated first
// line), so the jsonl file stays valid after truncation.
function truncateToTailHalf(content: string): string {
  const bytes = Buffer.byteLength(content, 'utf8');
  const targetBytes = Math.floor(bytes / 2);
  if (targetBytes <= 0) return '';
  // Work in bytes to slice roughly at targetBytes from the end, then trim to
  // a whole-line boundary.
  const buf = Buffer.from(content, 'utf8');
  const start = Math.max(0, buf.length - targetBytes);
  let tail = buf.slice(start).toString('utf8');
  const firstNewline = tail.indexOf('\n');
  if (start > 0) {
    // We started mid-file: the first line may be partial, drop it.
    tail = firstNewline === -1 ? '' : tail.slice(firstNewline + 1);
  }
  return tail;
}

export function appendReqLog(entry: ReqLogEntry, opts?: { path?: string; maxBytes?: number }): void {
  try {
    const path = resolveAppendPath(opts);
    const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_APPEND_BYTES;
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify(entry) + '\n';

    if (existsSync(path)) {
      const currentSize = statSync(path).size;
      const prospectiveSize = currentSize + Buffer.byteLength(line, 'utf8');
      if (prospectiveSize > maxBytes) {
        const content = readFileSync(path, 'utf8');
        const truncated = truncateToTailHalf(content);
        writeFileSync(path, truncated);
      }
    }

    appendFileSync(path, line);
  } catch {
    // appendReqLog must never throw — logging is best-effort.
  }
}

export function readReqLog(opts?: { path?: string; limit?: number; maxBytes?: number }): ReqLogEntry[] {
  try {
    const path = resolveAppendPath(opts);
    const limit = opts?.limit ?? DEFAULT_READ_LIMIT;
    const maxBytes = opts?.maxBytes ?? DEFAULT_READ_MAX_BYTES;
    if (!existsSync(path)) return [];

    const size = statSync(path).size;
    const readLen = Math.min(size, maxBytes);
    const start = size - readLen;
    let raw = '';
    if (readLen > 0) {
      const fd = openSync(path, 'r');
      try {
        const buffer = Buffer.alloc(readLen);
        readSync(fd, buffer, 0, readLen, start);
        raw = buffer.toString('utf8');
      } finally {
        closeSync(fd);
      }
    }
    if (start > 0) {
      // We may have started mid-line; drop the possibly-partial first line.
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const entries: ReqLogEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') {
          entries.push(parsed as ReqLogEntry);
        }
      } catch {
        // Skip malformed lines rather than failing the whole tail.
      }
    }
    return entries.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

// Aggregate token-savings telemetry over the tail of the request log. Reuses
// readReqLog (bounded tail read) so this stays cheap and, like everything here,
// never throws — a telemetry read must never break the console.
export function readSavings(opts?: { path?: string; limit?: number; maxBytes?: number }): SavingsSummary {
  const empty: SavingsSummary = { totalIn: 0, totalOut: 0, totalSaved: 0, requests: 0, byStage: {}, byModel: {} };
  try {
    const entries = readReqLog({ ...opts, limit: opts?.limit ?? 5000 });
    const summary: SavingsSummary = { totalIn: 0, totalOut: 0, totalSaved: 0, requests: 0, byStage: {}, byModel: {} };
    for (const e of entries) {
      if (typeof e.tokensIn !== 'number' && typeof e.tokensOut !== 'number' && typeof e.tokensSaved !== 'number') {
        continue;
      }
      const tin = e.tokensIn ?? 0;
      const tout = e.tokensOut ?? 0;
      const saved = e.tokensSaved ?? tin - tout;
      summary.totalIn += tin;
      summary.totalOut += tout;
      summary.totalSaved += saved;
      summary.requests += 1;
      const stage = e.stage || 'unknown';
      const bucket = summary.byStage[stage] ?? { in: 0, out: 0, saved: 0, requests: 0 };
      bucket.in += tin;
      bucket.out += tout;
      bucket.saved += saved;
      bucket.requests += 1;
      summary.byStage[stage] = bucket;

      const model = e.model || 'unknown';
      const mbucket = summary.byModel[model] ?? { in: 0, out: 0, saved: 0, requests: 0 };
      mbucket.in += tin;
      mbucket.out += tout;
      mbucket.saved += saved;
      mbucket.requests += 1;
      summary.byModel[model] = mbucket;
    }
    return summary;
  } catch {
    return empty;
  }
}

// Canonical top→bottom order for the savings funnel. Stages the request log
// hasn't seen are simply skipped; any stage id present in the log but missing
// here is appended (sorted) after these, so a newly-added stage still shows up.
export const FUNNEL_STAGE_ORDER = [
  'compact-router',
  'context-watchdog',
  'crush',
  'dedup',
  'image-shrink',
  'model-router',
  'thinking-damper',
  'rate-limiter',
] as const;

export type FunnelStage = {
  name: string; // display label (stage id for real stages, or a synthetic label)
  stage?: string; // stage id — present only for real per-stage slices
  kind: 'baseline' | 'stage' | 'sent';
  remaining: number; // tokens still in flight at this level = the funnel slice's value
  saved: number; // tokens removed getting from the previous level to this one (0 at baseline)
  pctOfBaseline: number; // remaining / baseline * 100
  pctOfPrev: number; // remaining / previous.remaining * 100 (100 at baseline)
  terminal?: boolean; // the bottom slice = what actually left towards the API
};

export type SavingsFunnel = {
  baseline: number; // totalIn — tokens that would have been sent with no savings layer
  sent: number; // totalOut — tokens actually forwarded upstream
  totalSaved: number; // baseline - sent
  savedPct: number; // totalSaved / baseline * 100
  requests: number; // entries carrying token telemetry
  // Ordered top→bottom. stages[0] is always the baseline; the last entry is
  // flagged `terminal` and its `remaining` equals `sent`.
  stages: FunnelStage[];
};

// readSavingsFunnel turns the flat per-stage savings summary into an ordered,
// arithmetically-closed funnel: baseline (would-be-sent) at the top, one slice
// per savings stage that actually removed tokens, and a terminal slice equal to
// what was really sent. Each stage's `saved` narrows the funnel by exactly that
// much, so the slices always add back up to the baseline. Never throws.
//
// Caveat worth knowing when reading the numbers: stages log independently per
// hop, so a request passing through N stages contributes to N `tokensIn`/
// `tokensOut` records. The per-stage *saved* amounts stay correct and additive,
// but the absolute baseline/sent totals are inflated by intermediate hops being
// counted as both an upstream stage's "out" and the next stage's "in".
export function readSavingsFunnel(opts?: { path?: string; limit?: number; maxBytes?: number }): SavingsFunnel {
  const empty: SavingsFunnel = { baseline: 0, sent: 0, totalSaved: 0, savedPct: 0, requests: 0, stages: [] };
  try {
    const s = readSavings(opts);
    const baseline = s.totalIn;
    const sent = s.totalOut;
    if (baseline <= 0) return { ...empty, requests: s.requests };

    const stages: FunnelStage[] = [
      { name: 'Would-be-sent', kind: 'baseline', remaining: baseline, saved: 0, pctOfBaseline: 100, pctOfPrev: 100 },
    ];

    const known = FUNNEL_STAGE_ORDER as readonly string[];
    const present = Object.keys(s.byStage);
    const ordered = [
      ...known.filter((id) => present.includes(id)),
      ...present.filter((id) => !known.includes(id)).sort(),
    ];

    let running = baseline;
    for (const id of ordered) {
      const bucket = s.byStage[id];
      // Only stages that actually removed tokens narrow the funnel; a stage that
      // merely forwarded (saved <= 0) would add a same-width slice and read as noise.
      if (!bucket || bucket.saved <= 0) continue;
      const prev = running;
      running -= bucket.saved;
      stages.push({
        name: id,
        stage: id,
        kind: 'stage',
        remaining: running,
        saved: bucket.saved,
        pctOfBaseline: (running / baseline) * 100,
        pctOfPrev: prev > 0 ? (running / prev) * 100 : 100,
      });
    }

    // Close the funnel at what really went out. When the stages above account
    // for every saved token, `running` already equals `sent` and no extra slice
    // is needed — we just flag the last stage as terminal. Otherwise (savings
    // not fully attributable to a stage) add an explicit terminal slice.
    if (Math.round(running) !== Math.round(sent)) {
      const prev = running;
      stages.push({
        name: 'Actually sent',
        kind: 'sent',
        remaining: sent,
        saved: prev - sent,
        pctOfBaseline: (sent / baseline) * 100,
        pctOfPrev: prev > 0 ? (sent / prev) * 100 : 100,
      });
    }
    stages[stages.length - 1]!.terminal = true;

    return {
      baseline,
      sent,
      totalSaved: baseline - sent,
      savedPct: (s.totalSaved / baseline) * 100,
      requests: s.requests,
      stages,
    };
  } catch {
    return empty;
  }
}

export type ParsedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

// Pull one `usage` object's cache/token counts into our field names. Anthropic
// splits input across input_tokens (uncached), cache_read_input_tokens, and
// cache_creation_input_tokens. Returns only the fields actually present.
function usageFields(usage: any): ParsedUsage {
  const out: ParsedUsage = {};
  if (!usage || typeof usage !== 'object') return out;
  if (typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') out.cacheRead = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') out.cacheWrite = usage.cache_creation_input_tokens;
  return out;
}

// Best-effort extraction of real token usage from an upstream /v1/messages
// response body, for prompt-cache telemetry. Handles both shapes:
//   - non-streaming JSON: top-level `usage`.
//   - SSE stream: `message_start` carries the input/cache counts (and a
//     provisional output_tokens); the final `output_tokens` lands in the last
//     `message_delta`. We merge both, letting later events override.
// Never throws and returns undefined when no usage is found — telemetry must
// never touch the response path.
export function parseUsage(body: string, contentType?: string): ParsedUsage | undefined {
  try {
    if (typeof body !== 'string' || body.length === 0) return undefined;
    const looksSse =
      (contentType ?? '').includes('event-stream') ||
      body.includes('event:') ||
      body.includes('\ndata:') ||
      body.startsWith('data:');

    if (looksSse) {
      const merged: ParsedUsage = {};
      let found = false;
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice('data:'.length).trim();
        if (payload === '' || payload === '[DONE]') continue;
        let evt: any;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        // message_start nests usage under `message`; message_delta puts it at
        // the top level.
        const usage = evt?.message?.usage ?? evt?.usage;
        const fields = usageFields(usage);
        for (const [k, v] of Object.entries(fields)) {
          (merged as any)[k] = v;
          found = true;
        }
      }
      return found ? merged : undefined;
    }

    const parsed = JSON.parse(body);
    const fields = usageFields(parsed?.usage);
    return Object.keys(fields).length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
}

export type CacheStats = {
  requests: number; // entries carrying real usage/cache telemetry
  totalInput: number; // sum of inputTokens (usage.input_tokens — uncached remainder)
  totalOutput: number; // sum of outputTokens
  totalCacheRead: number; // sum of cacheRead (cache_read_input_tokens)
  totalCacheWrite: number; // sum of cacheWrite (cache_creation_input_tokens)
  totalProcessed: number; // totalInput + totalCacheRead + totalCacheWrite — all input tokens seen
  freshInput: number; // totalInput + totalCacheWrite — tokens paid at full rate or higher
  cacheHitRatio: number; // totalCacheRead / totalProcessed
};

// Aggregate prompt-cache telemetry over the tail of the request log. Only
// entries that carry real usage (input/cache tokens parsed off an upstream
// response) are counted, so this never double-counts a request seen by several
// stages. Never throws — a telemetry read must never break the console.
//
// Anthropic's usage splits input three ways and they are additive, not nested:
// input_tokens is the *uncached* remainder, cache_read_input_tokens are served
// from cache (cheap), and cache_creation_input_tokens are written to cache
// (billed at ~1.25x). So the total input actually processed is the sum of all
// three (totalProcessed), and the tokens paid at full rate or higher are the
// uncached input plus the cache writes (freshInput). cacheHitRatio is the share
// of processed input that came from cache — the number that drops when a body
// rewrite breaks the cache prefix.
export function readCacheStats(opts?: { path?: string; limit?: number; maxBytes?: number }): CacheStats {
  const empty: CacheStats = {
    requests: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalProcessed: 0,
    freshInput: 0,
    cacheHitRatio: 0,
  };
  try {
    const entries = readReqLog({ ...opts, limit: opts?.limit ?? 5000 });
    const stats = { ...empty };
    for (const e of entries) {
      const hasUsage =
        typeof e.inputTokens === 'number' ||
        typeof e.cacheRead === 'number' ||
        typeof e.cacheWrite === 'number' ||
        typeof e.outputTokens === 'number';
      if (!hasUsage) continue;
      stats.requests += 1;
      stats.totalInput += e.inputTokens ?? 0;
      stats.totalOutput += e.outputTokens ?? 0;
      stats.totalCacheRead += e.cacheRead ?? 0;
      stats.totalCacheWrite += e.cacheWrite ?? 0;
    }
    stats.totalProcessed = stats.totalInput + stats.totalCacheRead + stats.totalCacheWrite;
    stats.freshInput = stats.totalInput + stats.totalCacheWrite;
    stats.cacheHitRatio = stats.totalProcessed > 0 ? stats.totalCacheRead / stats.totalProcessed : 0;
    return stats;
  } catch {
    return empty;
  }
}

export function summarizeBody(rawBody: Buffer): { model?: string; maxTokens?: number; bodySha: string; preview?: string } {
  const bodySha = createHash('sha256').update(rawBody).digest('hex').slice(0, 8);
  try {
    const result: { model?: string; maxTokens?: number; bodySha: string; preview?: string } = { bodySha };
    let parsed: any;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return result;
    }
    if (parsed && typeof parsed.model === 'string') result.model = parsed.model;
    if (parsed && typeof parsed.max_tokens === 'number') result.maxTokens = parsed.max_tokens;
    try {
      const messages = parsed?.messages;
      if (Array.isArray(messages)) {
        const userMsg = messages.find((m: any) => m && m.role === 'user');
        if (userMsg) {
          let text: string | undefined;
          if (typeof userMsg.content === 'string') {
            text = userMsg.content;
          } else if (Array.isArray(userMsg.content)) {
            const block = userMsg.content.find(
              (b: any) => b && (typeof b.text === 'string' || b.type === 'text'),
            );
            if (block && typeof block.text === 'string') text = block.text;
          }
          if (typeof text === 'string') {
            result.preview = text.slice(0, 80);
          }
        }
      }
    } catch {
      // preview omitted on failure
    }
    return result;
  } catch {
    return { bodySha };
  }
}
