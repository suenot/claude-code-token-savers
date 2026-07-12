// model-router proxy stage. Classifies each /v1/messages request into a task
// category and applies the configured route (model rewrite, optional upstream
// override, or image OCR). Structure mirrors the other built-in stages: only
// the one request type is rewritten, any error falls back to the raw body, and
// telemetry can never break the response path.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from '../compact/matcher.ts';
import { classifyRequest, type Routes } from './classify.ts';
import { applyRoute, type Upstream } from './apply.ts';
import { appendReqLog, summarizeBody } from '../control/reqlog.ts';
import { isStageEnabled } from '../control/toggles.ts';
import { anthropicToOpenAIRequest } from '../translate/request.ts';
import { openaiToAnthropicResponse } from '../translate/response.ts';
import { createOpenAIToAnthropicStream } from '../translate/stream.ts';

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

  // Build the outbound headers for a routed request, swapping in the target
  // endpoint's API key when one is configured.
  function outHeaders(req: IncomingMessage, override?: Upstream): Record<string, any> {
    const headers: Record<string, any> = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    delete headers['accept-encoding'];
    if (override?.envKey) {
      const key = process.env[override.envKey];
      if (key) {
        headers['x-api-key'] = key;
        headers['authorization'] = `Bearer ${key}`;
      }
    }
    return headers;
  }

  // Raw passthrough: forward the body byte-for-byte to `${target}${req.url}`.
  // Used for the upstream chain (no override) and native Anthropic overrides.
  async function forwardRaw(
    req: IncomingMessage,
    bodyBuf: Buffer,
    res: ServerResponse,
    override?: Upstream,
  ): Promise<number> {
    const target = override?.baseUrl ?? upstream;
    const up = await fetchImpl(target + req.url, {
      method: req.method,
      headers: outHeaders(req, override),
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

  // Translating forward: the routed body is Anthropic-shaped but the target
  // speaks OpenAI Chat Completions. Translate the request, POST to
  // `${baseUrl}/chat/completions` (baseUrl already ends with /v1 — do NOT append
  // req.url), then translate the response back to Anthropic — JSON or SSE.
  async function forwardTranslate(
    req: IncomingMessage,
    anthropicBody: any,
    res: ServerResponse,
    override: Upstream,
  ): Promise<number> {
    const { body: openaiBody, meta } = anthropicToOpenAIRequest(anthropicBody);
    const wantStream = openaiBody.stream === true;
    const headers = outHeaders(req, override);
    headers['content-type'] = 'application/json';
    // Anthropic-only content negotiation headers would confuse an OpenAI endpoint.
    delete headers['anthropic-version'];
    delete headers['anthropic-beta'];

    const up = await fetchImpl(override.baseUrl + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(openaiBody),
    } as RequestInit);
    const status = up.status || 200;

    // Errors: pass the upstream body through untranslated so the client sees the
    // real failure rather than a mistranslated one.
    if (!up.ok) {
      const text = up.body ? await up.text() : '';
      const ct = up.headers?.get?.('content-type') || 'application/json';
      res.writeHead(status, { 'content-type': ct });
      res.end(text);
      return status;
    }

    if (wantStream) {
      res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const translator = createOpenAIToAnthropicStream(meta);
      if (up.body) {
        const reader = (up.body as any).getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const ev of translator.write(chunk)) res.write(ev);
        }
      }
      for (const ev of translator.end()) res.write(ev);
      res.end();
      return status;
    }

    const json: any = await up.json();
    const anthropic = openaiToAnthropicResponse(json, meta);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(anthropic));
    return status;
  }

  // Dispatch: OpenAI-dialect overrides translate; everything else is raw.
  async function forward(
    req: IncomingMessage,
    bodyBuf: Buffer,
    res: ServerResponse,
    override?: Upstream,
  ): Promise<number> {
    if (override && override.dialect === 'openai') {
      let parsed: any = null;
      try {
        parsed = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        parsed = null;
      }
      if (parsed) return forwardTranslate(req, parsed, res, override);
    }
    return forwardRaw(req, bodyBuf, res, override);
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

              // Tool guard: a request carrying tools would need full tool-calling
              // translation to move to an OpenAI-dialect target. Unless the route
              // opts into 'translate', don't route it — pass it through to the
              // normal upstream chain untouched (byte-identical) and log why.
              const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
              if (override && override.dialect === 'openai' && hasTools && override.tools !== 'translate') {
                log('routed', category, 'tools=blocked', `→${override.baseUrl}`);
                const status = await forwardRaw(req, raw, res);
                logReq(status);
                return;
              }

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
