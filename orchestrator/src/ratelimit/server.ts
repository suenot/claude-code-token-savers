import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { appendReqLog, summarizeBody, parseUsage, type ParsedUsage } from '../control/reqlog.ts';
import { isStageEnabled } from '../control/toggles.ts';

const STAGE_ID = 'rate-limiter';

// A pure passthrough proxy that paces outbound requests to a steady rate so a
// bursty client (e.g. Claude Code retrying on overload) cannot machine-gun the
// upstream into repeated 429s. Requests are serialized through a token bucket:
// `rps` sustained rate, up to `burst` allowed back-to-back after an idle gap.
// When the upstream *does* answer 429, its Retry-After is honored globally —
// every queued request waits out the cooldown instead of piling on.

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Serialized token-bucket gate. `acquire()` resolves when the caller may fire.
export function createGate({ rps, burst, now = Date.now, sleep = defaultSleep }: {
  rps: number;
  burst: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): { acquire(): Promise<void>; penalize(ms: number): void } {
  const perMs = rps / 1000;
  let tokens = burst;
  let last = now();
  let pauseUntil = 0;
  let chain = Promise.resolve();

  function refill() {
    const t = now();
    tokens = Math.min(burst, tokens + (t - last) * perMs);
    last = t;
  }

  async function step() {
    // Global cooldown (from an upstream Retry-After) takes precedence.
    let wait = pauseUntil - now();
    if (wait > 0) await sleep(wait);
    refill();
    if (tokens < 1) {
      const need = Math.ceil((1 - tokens) / perMs);
      await sleep(need);
      refill();
    }
    tokens -= 1;
  }

  return {
    acquire() {
      const run = chain.then(step);
      chain = run.catch(() => {});
      return run;
    },
    // Extend the global cooldown so the whole queue waits out a 429.
    penalize(ms: number) {
      const until = now() + ms;
      if (until > pauseUntil) pauseUntil = until;
    },
  };
}

// Parse a Retry-After header (delta-seconds only; HTTP-date form is ignored and
// falls back to the default). Returns milliseconds.
export function retryAfterMs(header: string | null | undefined, fallbackMs: number): number {
  if (header == null) return fallbackMs;
  const secs = Number(String(header).trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  return fallbackMs;
}

export function createRateLimiter({
  port,
  upstream,
  rps = 2,
  burst = 5,
  default429CooldownMs = 5000,
  fetchImpl = fetch,
  now = Date.now,
  sleep = defaultSleep,
}: {
  port: number;
  upstream: string;
  rps?: number;
  burst?: number;
  default429CooldownMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Server {
  const log = (...a: string[]) => process.stderr.write(`[rate-limiter] ${a.join(' ')}\n`);
  const gate = createGate({ rps, burst, now, sleep });

  // Cap on the bytes we copy off a response for usage parsing. An SSE
  // message_start (which carries all the cache/input counts) arrives at the very
  // start, so even a modest cap always captures the cache telemetry; the cap
  // just bounds memory on very large responses.
  const USAGE_CAPTURE_CAP = 1_000_000;

  async function forward(req: IncomingMessage, bodyBuf: Buffer, res: ServerResponse, penalizeOn429 = true): Promise<{ status: number; usage?: ParsedUsage }> {
    const headers: Record<string, any> = { ...req.headers };
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, {
      method: req.method,
      headers,
      body: bodyBuf.length ? bodyBuf : undefined,
    } as RequestInit);
    if (up.status === 429 && penalizeOn429) {
      const cooldown = retryAfterMs(up.headers && up.headers.get ? up.headers.get('retry-after') : null, default429CooldownMs);
      gate.penalize(cooldown);
      log('upstream 429 — pausing queue', `${cooldown}ms`);
    }
    const out = Object.fromEntries((up.headers && up.headers.entries) ? up.headers.entries() : []);
    const contentType = typeof out['content-type'] === 'string' ? out['content-type'] : undefined;
    delete out['content-encoding']; delete out['content-length']; delete out['transfer-encoding'];
    res.writeHead(up.status || 200, out);
    let usage: ParsedUsage | undefined;
    if (up.body) {
      const stream = Readable.fromWeb(up.body as any);
      // Best-effort bounded tee: copy the bytes as they flow past so we can read
      // the real token/cache usage off the response, without ever consuming or
      // delaying what the client receives (pipe and this listener both see each
      // chunk). Any failure here is swallowed — telemetry never touches the
      // response path.
      const captured: Buffer[] = [];
      let capturedBytes = 0;
      stream.on('data', (chunk: Buffer) => {
        try {
          if (capturedBytes >= USAGE_CAPTURE_CAP) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          captured.push(buf);
          capturedBytes += buf.length;
        } catch { /* observation must never affect the response */ }
      });
      stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
      stream.pipe(res);
      // Wait for the stream to drain so `captured` is complete before we parse.
      // The client is served concurrently via pipe; this only defers the log.
      await new Promise<void>((resolve) => {
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', () => resolve());
      });
      try {
        usage = parseUsage(Buffer.concat(captured).toString('utf8'), contentType);
      } catch { /* best-effort */ }
    } else {
      res.end();
    }
    return { status: up.status || 200, usage };
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const isMessages = req.method === 'POST' && !!req.url && req.url.includes('/v1/messages');
      const summary = isMessages ? summarizeBody(raw) : undefined;
      const enabled = isStageEnabled(STAGE_ID);
      try {
        if (enabled) await gate.acquire();
        const start = Date.now();
        const { status, usage } = await forward(req, raw, res, enabled);
        try {
          appendReqLog({
            ts: new Date().toISOString(),
            stage: 'rate-limiter',
            method: req.method || 'POST',
            path: req.url || '',
            action: 'forward',
            upstreamStatus: status,
            durationMs: Date.now() - start,
            ...summary,
            // Real usage parsed off the upstream response (messages only). This
            // is the one stage that sees the real API answer, so cache telemetry
            // is recorded here and nowhere else.
            ...(isMessages && usage ? usage : {}),
          });
        } catch { /* logging must never affect the response path */ }
      } catch (e: any) {
        if (!res.headersSent) res.writeHead(502);
        res.end('rate-limiter error: ' + e.message);
      }
    });
  });
  return server;
}
