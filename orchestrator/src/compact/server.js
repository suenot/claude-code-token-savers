import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from './matcher.js';
import { anthropicToOpenAI, openAIMessageToAnthropic, anthropicSSEChunks } from './translate.js';

export function createInterceptor({ port, upstream, model, baseUrl, apiKey, fetchImpl = fetch }) {
  const log = (...a) => process.stderr.write(`[compact-router] ${a.join(' ')}\n`);

  async function passthrough(req, raw, res) {
    const headers = { ...req.headers };
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, { method: req.method, headers, body: raw.length ? raw : undefined });
    const out = Object.fromEntries((up.headers && up.headers.entries) ? up.headers.entries() : []);
    delete out['content-encoding']; delete out['content-length']; delete out['transfer-encoding'];
    res.writeHead(up.status || 200, out);
    if (up.body) Readable.fromWeb(up.body).pipe(res);
    else res.end();
  }

  async function serveCompact(body, res) {
    const oreq = anthropicToOpenAI(body, model);
    const r = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...oreq, stream: false }),
    });
    if (!r.ok) throw new Error(`external ${r.status}`);
    const data = await r.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('empty external content');
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const f of anthropicSSEChunks(text, { model })) res.write(f);
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(openAIMessageToAnthropic(text, { model })));
    }
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const isMessages = req.method === 'POST' && req.url.includes('/v1/messages') && !req.url.includes('count_tokens');
      let body = null;
      if (isMessages) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
      try {
        if (body && isCompactRequest(body)) {
          try {
            await serveCompact(body, res);
            log('intercepted', model);
            return;
          } catch (e) {
            log('fallback', e.message);
            await passthrough(req, raw, res);
            return;
          }
        }
        await passthrough(req, raw, res);
      } catch (e) {
        if (!res.headersSent) res.writeHead(502);
        res.end('compact-router error: ' + e.message);
      }
    });
  });
  return server;
}
