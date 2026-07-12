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
  'dedup',
  'image-shrink',
  'model-router',
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
