// model-router proxy stage. Classifies each /v1/messages request into a task
// category and applies the configured route (model rewrite, optional upstream
// override, or image OCR). Structure mirrors the other built-in stages: only
// the one request type is rewritten, any error falls back to the raw body, and
// telemetry can never break the response path.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from '../compact/matcher.ts';
import { classifyRequest, type Routes } from './classify.ts';
import { applyRoute } from './apply.ts';
import { appendReqLog, summarizeBody } from '../control/reqlog.ts';
import { isStageEnabled } from '../control/toggles.ts';

const STAGE_ID = 'model-router';

export function createModelRouter({
  port,
  upstream,
  routes,
  fetchImpl = fetch,
}: {
  port: number;
  upstream: string;
  routes: Routes;
  fetchImpl?: typeof fetch;
}): Server {
  const log = (...a: string[]) => process.stderr.write(`[model-router] ${a.join(' ')}\n`);
  void port;

  async function forward(
    req: IncomingMessage,
    bodyBuf: Buffer,
    res: ServerResponse,
    override?: { baseUrl: string; envKey?: string },
  ): Promise<number> {
    const target = override?.baseUrl ?? upstream;
    const headers: Record<string, any> = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers['accept-encoding'];
    // When routing to a different endpoint, swap in that endpoint's key.
    if (override?.envKey) {
      const key = process.env[override.envKey];
      if (key) {
        headers['x-api-key'] = key;
        headers['authorization'] = `Bearer ${key}`;
      }
    }
    const up = await fetchImpl(target + req.url, {
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

      function logReq(upstreamStatus: number, extra?: Record<string, unknown>) {
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
            ...(extra ?? {}),
          });
        } catch {
          /* logging must never affect the response path */
        }
      }

      try {
        if (isStageEnabled(STAGE_ID) && body && !isCompactRequest(body)) {
          try {
            const category = classifyRequest(body, routes);
            if (category !== 'default' || routes.default) {
              const { body: rewritten, upstream: override, stats } = applyRoute(body, category, routes);
              const changed = stats.routedModel || stats.ocrImages > 0 || override || stats.thinkingAction;
              if (changed) {
                log(
                  'routed',
                  category,
                  stats.routedModel ? `model=${stats.routedModel}` : '',
                  stats.ocrImages ? `ocr=${stats.ocrImages}` : '',
                  stats.thinkingAction ? `think=${stats.thinkingAction}(-${stats.thinkingSaved})` : '',
                  override ? `→${override.baseUrl}` : '',
                );
                const status = await forward(req, Buffer.from(JSON.stringify(rewritten)), res, override);
                logReq(status, {
                  model: stats.routedModel ?? summary?.model,
                  ...(stats.tokensSaved > 0 ? { tokensSaved: stats.tokensSaved } : {}),
                });
                // The thinking damper is its own funnel stage: log its savings
                // separately under 'thinking-damper' so they don't fold into the
                // model-router's own tokensSaved. Best-effort, like all logging.
                if (stats.thinkingAction) {
                  try {
                    appendReqLog({
                      ts: new Date().toISOString(),
                      stage: 'thinking-damper',
                      method: req.method || 'POST',
                      path: req.url || '',
                      action: 'intercept',
                      upstreamStatus: status,
                      ...summary,
                      model: stats.routedModel ?? summary?.model,
                      tokensSaved: stats.thinkingSaved,
                    });
                  } catch {
                    /* logging must never affect the response path */
                  }
                }
                return;
              }
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
        res.end('model-router error: ' + e.message);
      }
    });
  });
  return server;
}
