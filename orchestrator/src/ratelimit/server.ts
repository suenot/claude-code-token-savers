import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { appendReqLog, summarizeBody } from '../control/reqlog.ts';

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

  async function forward(req: IncomingMessage, bodyBuf: Buffer, res: ServerResponse): Promise<number> {
    const headers: Record<string, any> = { ...req.headers };
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, {
      method: req.method,
      headers,
      body: bodyBuf.length ? bodyBuf : undefined,
    } as RequestInit);
    if (up.status === 429) {
      const cooldown = retryAfterMs(up.headers && up.headers.get ? up.headers.get('retry-after') : null, default429CooldownMs);
      gate.penalize(cooldown);
      log('upstream 429 — pausing queue', `${cooldown}ms`);
    }
    const out = Object.fromEntries((up.headers && up.headers.entries) ? up.headers.entries() : []);
    delete out['content-encoding']; delete out['content-length']; delete out['transfer-encoding'];
    res.writeHead(up.status || 200, out);
    if (up.body) {
      const stream = Readable.fromWeb(up.body as any);
      stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
      stream.pipe(res);
    } else {
      res.end();
    }
    return up.status || 200;
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
      try {
        await gate.acquire();
        const start = Date.now();
        const status = await forward(req, raw, res);
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
