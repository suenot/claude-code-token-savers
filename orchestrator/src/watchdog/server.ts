import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from '../compact/matcher.ts';
import { anthropicToOpenAI } from '../compact/translate.ts';
import { estimateTokens } from './estimate.ts';
import { planCut } from './cut.ts';
import { summaryKey, buildRewrittenBody } from './rewrite.ts';
import { appendReqLog, summarizeBody } from '../control/reqlog.ts';
import { isStageEnabled } from '../control/toggles.ts';
import { createCache, type Cache } from '../cache/store.ts';

const STAGE_ID = 'context-watchdog';

const SUMMARIZE_PROMPT =
  'Summarize the conversation above in detail — decisions, code, file paths, current ' +
  'state, and next steps — so work can continue without the original transcript. ' +
  'Respond with the summary only.';
const CACHE_CAP = 64;
const SUMMARIZE_TIMEOUT_MS = 60000;

export function createWatchdog({ port, upstream, model, baseUrl, apiKey, thresholdTokens, tailTurns, fetchImpl = fetch, cache = new Map(), summaryCache = createCache() }: {
  port: number;
  upstream: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  thresholdTokens: number;
  tailTurns: number;
  fetchImpl?: typeof fetch;
  cache?: Map<string, any>;
  // Persistent content-hash cache for LLM-produced summaries: an identical
  // older-message prefix (same model) reuses its summary across restarts and
  // sessions, so the summarization call is only ever billed once. Separate from
  // `cache`, the in-memory sticky-cut reuse within a single live conversation.
  summaryCache?: Cache;
}): Server {
  const log = (...a: string[]) => process.stderr.write(`[context-watchdog] ${a.join(' ')}\n`);

  async function forward(req: IncomingMessage, bodyBuf: Buffer, res: ServerResponse): Promise<number> {
    const headers: Record<string, any> = { ...req.headers };
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, { method: req.method, headers, body: bodyBuf.length ? bodyBuf : undefined } as RequestInit);
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

  async function summarize(older: any[], system: any): Promise<string> {
    const oreq = anthropicToOpenAI({ system, messages: [...older, { role: 'user', content: SUMMARIZE_PROMPT }] }, model);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SUMMARIZE_TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...oreq, stream: false }),
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`external ${r.status}`);
      const data: any = await r.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error('empty summary');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  function cacheSet(key: string, val: any) {
    cache.set(key, val);
    while (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value as string);
  }

  // Decide the cut + summary for an over-threshold conversation, reusing a sticky
  // cut when the summarized prefix is unchanged and the live tail still fits under
  // the threshold. Returns { cut, summary } or null when no safe compaction exists.
  async function resolve(body: any) {
    const messages = body.messages || [];
    if (messages.length === 0) return null;
    const anchor = summaryKey([messages[0]]);
    const prev = cache.get(anchor);
    if (prev && messages.length > prev.cut && summaryKey(messages.slice(0, prev.cut)) === prev.olderHash) {
      const tail = messages.slice(prev.cut);
      if (estimateTokens({ system: body.system, messages: tail }) <= thresholdTokens) {
        log('reuse', anchor.slice(0, 8), 'cut', String(prev.cut));
        return { cut: prev.cut, summary: prev.summary };
      }
    }
    const split = planCut(messages, tailTurns);
    if (!split) return null;
    const cut = split.older.length;
    const olderHash = summaryKey(split.older);
    // Persistent cache is keyed by model + prefix hash: an LLM output, so no
    // algoVersion (content-only, never invalidated by a shuba release). A model
    // change lands in a different slot without invalidating other models'.
    const cacheKey = { namespace: 'watchdog-summary', content: `${model}\0${olderHash}` };
    let summary = summaryCache.get(cacheKey);
    if (summary === null) {
      summary = await summarize(split.older, body.system);
      summaryCache.set(cacheKey, summary);
      log('summarized', anchor.slice(0, 8), 'cut', String(cut));
    } else {
      log('cache-hit', anchor.slice(0, 8), 'cut', String(cut));
    }
    cacheSet(anchor, { olderHash, summary, cut });
    return { cut, summary };
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
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
      function logReq(
        action: 'summarize' | 'forward',
        upstreamStatus?: number,
        tokens?: { tokensIn: number; tokensOut: number },
      ) {
        try {
          appendReqLog({
            ts: new Date().toISOString(),
            stage: 'context-watchdog',
            method: req.method || 'POST',
            path: req.url || '',
            action,
            upstreamStatus,
            durationMs: Date.now() - start,
            ...summary,
            ...(tokens
              ? { tokensIn: tokens.tokensIn, tokensOut: tokens.tokensOut, tokensSaved: tokens.tokensIn - tokens.tokensOut }
              : {}),
          });
        } catch { /* logging must never affect the response path */ }
      }
      try {
        if (isStageEnabled(STAGE_ID) && body && !isCompactRequest(body) && estimateTokens(body) > thresholdTokens) {
          try {
            const r = await resolve(body);
            if (r) {
              const tail = (body.messages || []).slice(r.cut);
              const rewritten = buildRewrittenBody(body, tail, r.summary);
              const tokensIn = estimateTokens(body);
              const tokensOut = estimateTokens(rewritten);
              const status = await forward(req, Buffer.from(JSON.stringify(rewritten)), res);
              logReq('summarize', status, { tokensIn, tokensOut });
              return;
            }
          } catch (e: any) {
            log('fallback', e.message);
            const status = await forward(req, raw, res);
            logReq('forward', status);
            return;
          }
        }
        const status = await forward(req, raw, res);
        logReq('forward', status);
      } catch (e: any) {
        if (!res.headersSent) res.writeHead(502);
        res.end('context-watchdog error: ' + e.message);
      }
    });
  });
  return server;
}
