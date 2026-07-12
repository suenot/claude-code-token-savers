// Request classifier for model-router. Pure: given a request body and the
// configured routes, returns the winning task category by precedence. A
// category is only eligible if its route is configured, so an unconfigured
// category never shadows a lower-precedence one.

import { estimateTokens } from '../watchdog/estimate.ts';

export type Category = 'longContext' | 'image' | 'think' | 'webSearch' | 'background' | 'default';

export type Route = { model?: string; baseUrl?: string; envKey?: string };
export type ImageRoute = Route & {
  mode?: 'auto' | 'ocr' | 'vision-route' | 'off';
  dropImage?: boolean;
  ocrCommand?: string;
  ocrLang?: string;
};
export type Routes = {
  default?: Route;
  background?: Route;
  think?: Route;
  longContext?: Route & { threshold?: number };
  webSearch?: Route;
  image?: ImageRoute;
};

const DEFAULT_LONG_CONTEXT_THRESHOLD = 60_000;

export function hasImage(body: any): boolean {
  if (!body || !Array.isArray(body.messages)) return false;
  return body.messages.some(
    (m: any) => Array.isArray(m?.content) && m.content.some((b: any) => b && b.type === 'image'),
  );
}

// hasOcrKeyword: true when any user text mentions "ocr" (case-insensitive). The
// image route's `auto` mode uses this — text says OCR → extract text locally
// (free); otherwise the image is real analysis → send to a vision model.
export function hasOcrKeyword(body: any): boolean {
  if (!body || !Array.isArray(body.messages)) return false;
  for (const m of body.messages) {
    const c = m?.content;
    if (typeof c === 'string') {
      if (/ocr/i.test(c)) return true;
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string' && /ocr/i.test(b.text)) return true;
      }
    }
  }
  return false;
}

function isThinking(body: any): boolean {
  const t = body?.thinking;
  if (!t) return false;
  if (typeof t === 'object') return t.type === 'enabled' || t.enabled === true;
  return t === true;
}

function hasWebSearch(body: any): boolean {
  if (!Array.isArray(body?.tools)) return false;
  return body.tools.some((t: any) => {
    const name = typeof t?.name === 'string' ? t.name : '';
    const type = typeof t?.type === 'string' ? t.type : '';
    return /web_search/i.test(name) || /web_search/i.test(type);
  });
}

function isBackground(body: any): boolean {
  return typeof body?.model === 'string' && /haiku/i.test(body.model);
}

// An image route counts as configured when it exists and is not explicitly
// 'off' (it can do OCR without a model). Every other route needs a model or a
// baseUrl to have any effect.
function imageConfigured(r?: ImageRoute): boolean {
  return !!r && r.mode !== 'off';
}
function routeConfigured(r?: Route): boolean {
  return !!r && (typeof r.model === 'string' || typeof r.baseUrl === 'string');
}

export function classifyRequest(body: any, routes: Routes): Category {
  if (!body || typeof body !== 'object') return 'default';

  const lc = routes.longContext;
  if (routeConfigured(lc)) {
    const threshold = lc?.threshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD;
    if (estimateTokens(body) > threshold) return 'longContext';
  }
  if (imageConfigured(routes.image) && hasImage(body)) return 'image';
  if (routeConfigured(routes.think) && isThinking(body)) return 'think';
  if (routeConfigured(routes.webSearch) && hasWebSearch(body)) return 'webSearch';
  if (routeConfigured(routes.background) && isBackground(body)) return 'background';
  return 'default';
}
