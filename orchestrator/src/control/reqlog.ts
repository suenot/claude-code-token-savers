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
  const empty: SavingsSummary = { totalIn: 0, totalOut: 0, totalSaved: 0, requests: 0, byStage: {} };
  try {
    const entries = readReqLog({ ...opts, limit: opts?.limit ?? 5000 });
    const summary: SavingsSummary = { totalIn: 0, totalOut: 0, totalSaved: 0, requests: 0, byStage: {} };
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
    }
    return summary;
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
