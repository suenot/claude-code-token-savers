// Applies a route to a request body. A route's `model` is a single-string
// target (provider/[subprovider/]model, see control/target.ts); resolveTarget
// turns it into the body.model to send plus, for a known provider, the upstream
// endpoint + key. The image category additionally runs OCR extraction per its
// `mode`.

import type { Category, Routes, Route, ImageRoute, ThinkingControl } from './classify.ts';
import { hasOcrKeyword } from './classify.ts';
import { extractText, type SpawnLike } from '../image/ocr.ts';
import { resolveTarget } from '../control/providers.ts';

const PX_PER_TOKEN = 750;
// a8e exposes MiniMax as a8e-1.0-flash (upstream minimaxai/minimax-m2.7).
const DEFAULT_VISION_TARGET = 'a8e/auto';

const FORMATS = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type Upstream = {
  baseUrl: string;
  envKey?: string;
  // The wire dialect the endpoint speaks (see Route.dialect). Defaults to
  // 'openai' for every resolved override except native Anthropic; the router
  // uses this to decide whether to translate the request/response.
  dialect: 'openai' | 'anthropic';
  // Tool guard for this route (see Route.tools). Defaults to 'block'.
  tools: 'block' | 'translate';
};
export type ApplyStats = {
  category: Category;
  routedModel?: string;
  ocrImages: number;
  tokensSaved: number;
  // Thinking damper: set only when the outgoing `thinking` param was actually
  // modified. `thinkingSaved` is the budget_tokens removed (strip) or reduced
  // (cap) — the honest upper bound on thinking tokens the request permitted;
  // actual thinking usage varies and is usually lower. Telemetry is logged
  // under a separate stage id ('thinking-damper'), so this is kept apart from
  // the model-router's own `tokensSaved` above.
  thinkingAction?: 'strip' | 'cap';
  thinkingSaved: number;
};
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
  // Native Anthropic is byte-passthrough; every other known provider (a8e,
  // openrouter, openai, deepseek) is OpenAI-shaped and needs translation. An
  // explicit route.dialect always wins.
  const dialect: 'openai' | 'anthropic' =
    route.dialect ?? (r.target.provider === 'anthropic' ? 'anthropic' : 'openai');
  const tools: 'block' | 'translate' = route.tools ?? 'block';
  const upstream: Upstream | undefined = route.baseUrl
    ? { baseUrl: route.baseUrl, envKey: route.envKey, dialect, tools }
    : r.baseUrl
      ? { baseUrl: r.baseUrl, envKey: r.envKey, dialect, tools }
      : undefined;
  return { model: r.model, upstream };
}

// Read the budget_tokens on a body's `thinking` param, if it carries one. A
// thinking param can be enabled without an explicit budget (e.g. { type:
// 'enabled' }), in which case the request permitted no bounded budget and the
// removable estimate is 0.
function budgetOf(body: any): number {
  const t = body?.thinking;
  if (t && typeof t === 'object' && typeof t.budget_tokens === 'number' && t.budget_tokens > 0) {
    return t.budget_tokens;
  }
  return 0;
}

// Resolve the thinking control for a category: an explicit route.thinking wins;
// otherwise the 'background' (cheap) category strips by default. Every other
// category is left untouched unless its route opts in.
function thinkingControlFor(route: Route | undefined, category: Category): ThinkingControl | undefined {
  if (route && route.thinking !== undefined) return route.thinking;
  if (category === 'background') return 'strip';
  return undefined;
}

// Apply the thinking damper to the outgoing body. Returns the (possibly
// rewritten) body plus what it did, for telemetry. Never adds a thinking param
// that wasn't there; only strips or lowers an existing one.
function applyThinkingDamper(
  body: any,
  route: Route | undefined,
  category: Category,
): { body: any; action?: 'strip' | 'cap'; saved: number } {
  const control = thinkingControlFor(route, category);
  if (!control || control === 'keep') return { body, saved: 0 };

  if (control === 'strip') {
    if (!body || body.thinking === undefined) return { body, saved: 0 };
    const saved = budgetOf(body); // honest upper bound; actual thinking usage varies
    const { thinking, ...rest } = body;
    return { body: rest, action: 'strip', saved };
  }

  // budget cap
  const cap = control.budget;
  const current = budgetOf(body);
  if (current <= cap) return { body, saved: 0 }; // absent or already within cap → untouched
  const saved = current - cap;
  return { body: { ...body, thinking: { ...body.thinking, budget_tokens: cap } }, action: 'cap', saved };
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
  const stats: ApplyStats = { category, ocrImages: 0, tokensSaved: 0, thinkingSaved: 0 };

  // damp folds the thinking damper into a result body, recording what it did on
  // `stats`. Called at each return so every routed path is damped consistently.
  const damp = (outBody: any, route: Route | undefined): any => {
    const d = applyThinkingDamper(outBody, route, category);
    if (d.action) {
      stats.thinkingAction = d.action;
      stats.thinkingSaved = d.saved;
    }
    return d.body;
  };

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
    return { body: damp(outBody, routes.image), upstream, stats };
  }

  const route: Route | undefined = (routes as any)[category];
  if (!route || typeof route.model !== 'string' || !route.model) {
    // No model rewrite for this category, but the damper still applies — e.g. a
    // background route can strip thinking without changing the model.
    return { body: damp(body, route), stats };
  }
  const t = targetOf(route, route.model);
  stats.routedModel = t.model;
  return { body: damp({ ...body, model: t.model }, route), upstream: t.upstream, stats };
}
