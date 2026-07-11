import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { isCompactRequest } from '../compact/matcher.js';
import { anthropicToOpenAI } from '../compact/translate.js';
import { estimateTokens } from './estimate.js';
import { planCut } from './cut.js';
import { summaryKey, buildRewrittenBody } from './rewrite.js';

const SUMMARIZE_PROMPT =
  'Summarize the conversation above in detail — decisions, code, file paths, current ' +
  'state, and next steps — so work can continue without the original transcript. ' +
  'Respond with the summary only.';
const CACHE_CAP = 64;
const SUMMARIZE_TIMEOUT_MS = 60000;

export function createWatchdog({ port, upstream, model, baseUrl, apiKey, thresholdTokens, tailTurns, fetchImpl = fetch, cache = new Map() }) {
  const log = (...a) => process.stderr.write(`[context-watchdog] ${a.join(' ')}\n`);

  async function forward(req, bodyBuf, res) {
    const headers = { ...req.headers };
    delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const up = await fetchImpl(upstream + req.url, { method: req.method, headers, body: bodyBuf.length ? bodyBuf : undefined });
    const out = Object.fromEntries((up.headers && up.headers.entries) ? up.headers.entries() : []);
    delete out['content-encoding']; delete out['content-length']; delete out['transfer-encoding'];
    res.writeHead(up.status || 200, out);
    if (up.body) {
      const stream = Readable.fromWeb(up.body);
      stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
      stream.pipe(res);
    } else {
      res.end();
    }
  }

  async function summarize(older, system) {
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
      const data = await r.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error('empty summary');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  function cacheSet(key, val) {
    cache.set(key, val);
    while (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
  }

  // Decide the cut + summary for an over-threshold conversation, reusing a sticky
  // cut when the summarized prefix is unchanged and the live tail still fits under
  // the threshold. Returns { cut, summary } or null when no safe compaction exists.
  async function resolve(body) {
    const messages = body.messages || [];
    if (messages.length === 0) return null;
    const anchor = summaryKey([messages[0]]);
    const prev = cache.get(anchor);
    if (prev && messages.length > prev.cut && summaryKey(messages.slice(0, prev.cut)) === prev.olderHash) {
      const tail = messages.slice(prev.cut);
      if (estimateTokens({ system: body.system, messages: tail }) <= thresholdTokens) {
        log('reuse', anchor.slice(0, 8), 'cut', prev.cut);
        return { cut: prev.cut, summary: prev.summary };
      }
    }
    const split = planCut(messages, tailTurns);
    if (!split) return null;
    const cut = split.older.length;
    const summary = await summarize(split.older, body.system);
    cacheSet(anchor, { olderHash: summaryKey(split.older), summary, cut });
    log('summarized', anchor.slice(0, 8), 'cut', cut);
    return { cut, summary };
  }

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const isMessages = req.method === 'POST' && req.url.includes('/v1/messages') && !req.url.includes('count_tokens');
      let body = null;
      if (isMessages) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
      try {
        if (body && !isCompactRequest(body) && estimateTokens(body) > thresholdTokens) {
          try {
            const r = await resolve(body);
            if (r) {
              const tail = (body.messages || []).slice(r.cut);
              const rewritten = buildRewrittenBody(body, tail, r.summary);
              await forward(req, Buffer.from(JSON.stringify(rewritten)), res);
              return;
            }
          } catch (e) {
            log('fallback', e.message);
            await forward(req, raw, res);
            return;
          }
        }
        await forward(req, raw, res);
      } catch (e) {
        if (!res.headersSent) res.writeHead(502);
        res.end('context-watchdog error: ' + e.message);
      }
    });
  });
  return server;
}
