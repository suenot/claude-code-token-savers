// skill-inject proxy stage. Appends a compact "Available skills" system block to
// outgoing /v1/messages requests so Claude can rediscover the few skills relevant
// to the task after the capabilities store has stripped them from CC's context
// (see src/skillinject/inject.ts for the full rationale + cache-stability rules).
//
// Structure mirrors src/crush/server.ts: a plain passthrough that only rewrites
// /v1/messages, falls back to the raw body on any error, and logs telemetry that
// can never break the response path.
//
// TELEMETRY IS NEGATIVE HERE BY DESIGN. This stage ADDS tokens (the injected
// block), so tokensOut > tokensIn and tokensSaved is negative. That is correct
// and intentional: the honest cost of this hop belongs in the funnel. The big
// saving does NOT show up here — it shows up upstream, as Claude Code's own
// context shrinking once the capabilities store removed the skill listings. We
// log tokensIn/tokensOut so the funnel can show this hop's real (negative) cost.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { isCompactRequest } from '../compact/matcher.ts';
import { estimateTokens } from '../watchdog/estimate.ts';
import { appendReqLog, summarizeBody } from '../control/reqlog.ts';
import { isStageEnabled } from '../control/toggles.ts';
import { resolveTarget } from '../control/providers.ts';
import { BlockCache, injectRequest, type CapabilityEntry } from './inject.ts';

const STAGE_ID = 'skill-inject';

// Read the capabilities manifest fresh per request. Cheap (small JSON) and keeps
// us honest about skills toggled on/off in the store; the classifier result is
// still cached per conversation, so a manifest reread does not re-run the LLM.
function loadManifest(storeDir: string): CapabilityEntry[] {
  try {
    const raw = readFileSync(`${storeDir}/manifest.json`, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createSkillInject({
  port,
  upstream,
  maxSkills,
  classifierModel = 'a8e/auto',
  storeDir,
  enabled = true,
  fetchImpl = fetch,
  classifierFetch,
}: {
  port: number;
  upstream: string;
  maxSkills?: number;
  classifierModel?: string;
  storeDir?: string;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  // Separate fetch for the classifier LLM call, so tests can drive selection
  // without also intercepting the upstream forward. Defaults to fetchImpl.
  classifierFetch?: any;
}): Server {
  const log = (...a: string[]) => process.stderr.write(`[skill-inject] ${a.join(' ')}\n`);
  void port; // signature parity with sibling stages; listen() is the caller's job

  const cache = new BlockCache(200);
  const resolvedStore = storeDir || `${process.env.HOME || ''}/.shuba/capabilities`;
  // Resolve the classifier's provider env key up front so the LLM call carries
  // an API key (same resolution the sibling classifier uses).
  const t = resolveTarget(classifierModel);
  const apiKey = t.envKey ? process.env[t.envKey] : undefined;

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
        if (enabled && isStageEnabled(STAGE_ID) && body && !isCompactRequest(body)) {
          try {
            const manifest = loadManifest(resolvedStore);
            const { body: rewritten, stats } = await injectRequest(body, manifest, {
              cache,
              maxSkills,
              classifierModel,
              storeDir: resolvedStore,
              fetchImpl: classifierFetch ?? (fetchImpl as any),
              apiKey,
            });
            if (stats.injected) {
              const before = estimateTokens(body);
              const after = estimateTokens(rewritten);
              // saved is negative here — this stage ADDS the injected block (see
              // the file header). We report it honestly rather than clamp to 0.
              const saved = before - after;
              log('injected', String(stats.skillCount), 'skill(s)', `${before}→${after}tok`, `${saved}tok`);
              const status = await forward(req, Buffer.from(JSON.stringify(rewritten)), res);
              logReq(status, { tokensIn: before, tokensOut: after, tokensSaved: saved });
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
        res.end('skill-inject error: ' + e.message);
      }
    });
  });
  return server;
}
