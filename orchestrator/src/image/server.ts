// image-shrink proxy stage. Downscales base64 images in outgoing
// /v1/messages requests, then forwards. Structure mirrors src/dedup/server.ts:
// a plain passthrough that only rewrites the one request type it understands,
// falls back to the raw body on any error, and logs telemetry that can never
// break the response path. Unlike dedup it emits tokensIn/out/saved (+ model)
// so readSavings() attributes the savings — including per-model.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from '../compact/matcher.ts';
import { shrinkBody } from './shrink.ts';
import { appendReqLog, summarizeBody } from '../control/reqlog.ts';
import { isStageEnabled } from '../control/toggles.ts';

const STAGE_ID = 'image-shrink';

export function createImageShrink({
  port,
  upstream,
  scale,
  minBytes,
  fetchImpl = fetch,
}: {
  port: number;
  upstream: string;
  scale?: number | string;
  minBytes?: number;
  fetchImpl?: typeof fetch;
}): Server {
  const log = (...a: string[]) => process.stderr.write(`[image-shrink] ${a.join(' ')}\n`);
  void port; // accepted for signature parity with sibling stages; listen() is caller's job

  async function forward(req: IncomingMessage, bodyBuf: Buffer, res: ServerResponse): Promise<number> {
    const headers: Record<string, any> = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, {
      method: req.method,
      headers,
      body: bodyBuf.length ? bodyBuf : undefined,
    } as RequestInit);
    const out = Object.fromEntries(up.headers && up.headers.entries ? up.headers.entries() : []);
    delete out['content-encoding'];
    delete out['content-length'];
    delete out['transfer-encoding'];
    res.writeHead(up.status || 200, out);
    if (up.body) {
      const stream = Readable.fromWeb(up.body as any);
      stream.on('error', () => {
        try {
          res.destroy();
        } catch {
          /* already closed */
        }
      });
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
      const isMessages =
        req.method === 'POST' && !!req.url && req.url.includes('/v1/messages') && !req.url.includes('count_tokens');
      let body: any = null;
      if (isMessages) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          body = null;
        }
      }
      const start = Date.now();
      const summary = isMessages ? summarizeBody(raw) : undefined;

      function logReq(upstreamStatus?: number, tokens?: { tokensIn: number; tokensOut: number; tokensSaved: number }) {
        try {
          appendReqLog({
            ts: new Date().toISOString(),
            stage: STAGE_ID,
            method: req.method || 'POST',
            path: req.url || '',
            action: 'forward',
            upstreamStatus,
            durationMs: Date.now() - start,
            ...summary,
            ...(tokens ?? {}),
          });
        } catch {
          /* logging must never affect the response path */
        }
      }

      try {
        if (isStageEnabled(STAGE_ID) && body && !isCompactRequest(body)) {
          try {
            const { body: rewritten, stats } = await shrinkBody(body, { scale, minBytes });
            if (stats.images > 0 && stats.savedBytes > 0) {
              const saved = Math.max(0, stats.tokensBefore - stats.tokensAfter);
              log(
                'shrank',
                String(stats.images),
                'image(s)',
                `${stats.tokensBefore}→${stats.tokensAfter}tok`,
                `-${stats.savedBytes}B`,
              );
              const status = await forward(req, Buffer.from(JSON.stringify(rewritten)), res);
              logReq(status, { tokensIn: stats.tokensBefore, tokensOut: stats.tokensAfter, tokensSaved: saved });
              return;
            }
          } catch (e: any) {
            log('fallback', e.message);
            const status = await forward(req, raw, res);
            logReq(status);
            return;
          }
        }
        const status = await forward(req, raw, res);
        logReq(status);
      } catch (e: any) {
        if (!res.headersSent) res.writeHead(502);
        res.end('image-shrink error: ' + e.message);
      }
    });
  });
  return server;
}
