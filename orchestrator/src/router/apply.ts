// Applies a route to a request body. A route's `model` is a single-string
// target (provider/[subprovider/]model, see control/target.ts); resolveTarget
// turns it into the body.model to send plus, for a known provider, the upstream
// endpoint + key. The image category additionally runs OCR extraction per its
// `mode`.

import type { Category, Routes, Route, ImageRoute } from './classify.ts';
import { hasOcrKeyword } from './classify.ts';
import { extractText, type SpawnLike } from '../image/ocr.ts';
import { resolveTarget } from '../control/providers.ts';

const PX_PER_TOKEN = 750;
// a8e exposes MiniMax as a8e-1.0-flash (upstream minimaxai/minimax-m2.7).
const DEFAULT_VISION_TARGET = 'a8e/a8e-1.0-flash';

const FORMATS = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type Upstream = { baseUrl: string; envKey?: string };
export type ApplyStats = { category: Category; routedModel?: string; ocrImages: number; tokensSaved: number };
export type ApplyResult = { body: any; upstream?: Upstream; stats: ApplyStats };

function estImageTokens(block: any): number {
  const data = block?.source?.data;
  if (typeof data !== 'string') return 0;
  return Math.round(Buffer.byteLength(data, 'base64') / PX_PER_TOKEN);
}

// Resolve a route's target string into { model, upstream }. An explicit
// route.baseUrl always wins over the provider registry.
function targetOf(route: Route, raw: string): { model: string; upstream?: Upstream } {
  const r = resolveTarget(raw);
  const upstream: Upstream | undefined = route.baseUrl
    ? { baseUrl: route.baseUrl, envKey: route.envKey }
    : r.baseUrl
      ? { baseUrl: r.baseUrl, envKey: r.envKey }
      : undefined;
  return { model: r.model, upstream };
}

// OCR-extract text from each image (mode 'ocr' only); optionally drop the pixels.
function runOcr(body: any, route: ImageRoute, spawnImpl?: SpawnLike): { body: any; ocrImages: number; tokensSaved: number } {
  let ocrImages = 0;
  let tokensSaved = 0;
  const messages = body.messages.map((message: any) => {
    if (!message || !Array.isArray(message.content)) return message;
    const out: any[] = [];
    for (const block of message.content) {
      if (block && block.type === 'image') {
        const src = block.source;
        if (src && src.type === 'base64' && typeof src.data === 'string' && FORMATS.has(src.media_type)) {
          const text = extractText(Buffer.from(src.data, 'base64'), src.media_type, {
            ocrCommand: route.ocrCommand,
            ocrLang: route.ocrLang,
            spawnImpl,
          });
          if (text) {
            ocrImages += 1;
            out.push({ type: 'text', text: `[shuba-ocr]\n${text}` });
            if (route.dropImage) {
              tokensSaved += Math.max(0, estImageTokens(block) - Math.round(text.length / 4));
              continue;
            }
          }
        }
      }
      out.push(block);
    }
    return { ...message, content: out };
  });
  return { body: { ...body, messages }, ocrImages, tokensSaved };
}

export function applyRoute(
  body: any,
  category: Category,
  routes: Routes,
  opts: { spawnImpl?: SpawnLike } = {},
): ApplyResult {
  const stats: ApplyStats = { category, ocrImages: 0, tokensSaved: 0 };

  if (category === 'image') {
    const route = routes.image ?? {};
    let mode = route.mode ?? 'auto';
    // auto: text mentions OCR -> extract locally (free); otherwise it is real
    // image analysis -> route to a vision model if one is configured, else let
    // the flagship handle it (passthrough).
    if (mode === 'auto') {
      mode = hasOcrKeyword(body) ? 'ocr' : route.model ? 'vision-route' : 'off';
    }
    let outBody = body;
    let upstream: Upstream | undefined;

    if (mode === 'ocr') {
      const ocr = runOcr(body, route, opts.spawnImpl);
      outBody = ocr.body;
      stats.ocrImages = ocr.ocrImages;
      stats.tokensSaved = ocr.tokensSaved;
    }

    // vision-route rewrites to a cheap vision model; ocr may also carry a target.
    const raw = route.model || (mode === 'vision-route' ? DEFAULT_VISION_TARGET : '');
    if (raw && mode !== 'off') {
      const t = targetOf(route, raw);
      outBody = { ...outBody, model: t.model };
      stats.routedModel = t.model;
      upstream = t.upstream;
    }
    return { body: outBody, upstream, stats };
  }

  const route: Route | undefined = (routes as any)[category];
  if (!route || typeof route.model !== 'string' || !route.model) {
    if (category === 'default' && !routes.default) return { body, stats };
    return { body, stats };
  }
  const t = targetOf(route, route.model);
  stats.routedModel = t.model;
  return { body: { ...body, model: t.model }, upstream: t.upstream, stats };
}
