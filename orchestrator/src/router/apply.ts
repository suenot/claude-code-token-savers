// Applies a route to a request body. For most categories this is a model
// rewrite (+ optional upstream override). For the image category it also runs
// OCR-extraction or a vision-model rewrite per the route's `mode`.

import type { Category, Routes, Route, ImageRoute } from './classify.ts';
import { extractText, type SpawnLike } from '../image/ocr.ts';

const PX_PER_TOKEN = 750;
const DEFAULT_VISION_MODEL = 'claude-haiku-4-5';

const FORMATS = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type ApplyStats = { category: Category; routedModel?: string; ocrImages: number; tokensSaved: number };
export type ApplyResult = { body: any; upstream?: { baseUrl: string; envKey?: string }; stats: ApplyStats };

function estImageTokens(block: any): number {
  // We do not have decoded dims here; approximate from base64 byte length,
  // which is only used for drop-image savings telemetry (never a decision).
  const data = block?.source?.data;
  if (typeof data !== 'string') return 0;
  const bytes = Buffer.byteLength(data, 'base64');
  return Math.round(bytes / PX_PER_TOKEN);
}

// applyImage handles the image route's pixel behaviour. Returns the rewritten
// body plus OCR stats. spawnImpl is threaded through for test injection.
function applyImage(body: any, route: ImageRoute, spawnImpl?: SpawnLike): { body: any; ocrImages: number; tokensSaved: number } {
  const mode = route.mode ?? 'ocr';
  let ocrImages = 0;
  let tokensSaved = 0;

  if (mode === 'vision-route') {
    const model = route.model ?? DEFAULT_VISION_MODEL;
    return { body: { ...body, model }, ocrImages: 0, tokensSaved: 0 };
  }
  if (mode === 'off') return { body, ocrImages: 0, tokensSaved: 0 };

  // mode === 'ocr': extract text from each image, inject a text block before it.
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
              continue; // drop the pixels
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
  if (category === 'default' && !routes.default) return { body, stats };

  if (category === 'image') {
    const route = routes.image ?? {};
    const res = applyImage(body, route, opts.spawnImpl);
    stats.ocrImages = res.ocrImages;
    stats.tokensSaved = res.tokensSaved;
    let outBody = res.body;
    // vision-route already rewrote model inside applyImage; ocr/off may still
    // carry a model override on the image route.
    if ((route.mode ?? 'ocr') !== 'vision-route' && typeof route.model === 'string') {
      outBody = { ...outBody, model: route.model };
      stats.routedModel = route.model;
    } else if ((route.mode ?? 'ocr') === 'vision-route') {
      stats.routedModel = outBody.model;
    }
    const upstream = route.baseUrl ? { baseUrl: route.baseUrl, envKey: route.envKey } : undefined;
    return { body: outBody, upstream, stats };
  }

  const route: Route | undefined = (routes as any)[category];
  if (!route) return { body, stats };
  let outBody = body;
  if (typeof route.model === 'string') {
    outBody = { ...body, model: route.model };
    stats.routedModel = route.model;
  }
  const upstream = route.baseUrl ? { baseUrl: route.baseUrl, envKey: route.envKey } : undefined;
  return { body: outBody, upstream, stats };
}
