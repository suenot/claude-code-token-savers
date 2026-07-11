import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from './matcher.ts';
import { anthropicToOpenAI, openAIMessageToAnthropic, anthropicSSEChunks, mapStopReason } from './translate.ts';
import { appendReqLog, summarizeBody } from '../control/reqlog.ts';

export function createInterceptor({ port, upstream, model, baseUrl, apiKey, fetchImpl = fetch }: {
  port: number;
  upstream: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Server {
  const log = (...a: string[]) => process.stderr.write(`[compact-router] ${a.join(' ')}\n`);

  async function passthrough(req: IncomingMessage, raw: Buffer, res: ServerResponse): Promise<number> {
    const headers: Record<string, any> = { ...req.headers };
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, { method: req.method, headers, body: raw.length ? raw : undefined } as RequestInit);
    const out = Object.fromEntries((up.headers && up.headers.entries) ? up.headers.entries() : []);
    delete out['content-encoding']; delete out['content-length']; delete out['transfer-encoding'];
    res.writeHead(up.status || 200, out);
    if (up.body) {
      const stream = Readable.fromWeb(up.body as any);
      stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
      stream.pipe(res);
    } else res.end();
    return up.status || 200;
  }

  async function serveCompact(body: any, res: ServerResponse) {
    const oreq = anthropicToOpenAI(body, model);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60000);
    let r;
    try {
      r = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...oreq, stream: false }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new Error(`external ${r.status}`);
    const data: any = await r.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('empty external content');
    const usage = data.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;
    const stopReason = mapStopReason(data.choices?.[0]?.finish_reason);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const f of anthropicSSEChunks(text, { model, inputTokens, outputTokens, stopReason })) res.write(f);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(openAIMessageToAnthropic(text, { model, inputTokens, outputTokens, stopReason })));
    }
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
      const isMessages = req.method === 'POST' && !!req.url && req.url.includes('/v1/messages') && !req.url.includes('count_tokens');
      let body: any = null;
      if (isMessages) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
      const start = Date.now();
      const summary = isMessages ? summarizeBody(raw) : undefined;
      function logReq(action: 'intercept' | 'passthrough', upstreamStatus?: number) {
        try {
          appendReqLog({
            ts: new Date().toISOString(),
            stage: 'compact-router',
            method: req.method || 'POST',
            path: req.url || '',
            action,
            upstreamStatus,
            durationMs: Date.now() - start,
            ...summary,
          });
        } catch { /* logging must never affect the response path */ }
      }
      try {
        if (body && isCompactRequest(body)) {
          try {
            await serveCompact(body, res);
            log('intercepted', model);
            logReq('intercept');
            return;
          } catch (e: any) {
            log('fallback', e.message);
            const status = await passthrough(req, raw, res);
            logReq('passthrough', status);
            return;
          }
        }
        const status = await passthrough(req, raw, res);
        logReq('passthrough', status);
      } catch (e: any) {
        if (!res.headersSent) res.writeHead(502);
        res.end('compact-router error: ' + e.message);
      }
    });
  });
  return server;
}
