// Read/write model-router route config in chain.json (~/.shuba/chain.json).
// The model-router stage reads its routes from an env var baked at launch, so
// edits here are persisted but take effect on the next `shuba run` (restart
// required) — the console surfaces that.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from '../config.ts';

const CATEGORIES = ['default', 'background', 'think', 'longContext', 'webSearch', 'image'] as const;
type Category = (typeof CATEGORIES)[number];

type Route = Record<string, unknown>;
export type Routes = Partial<Record<Category, Route>>;

// Keep only the fields we understand, with the right primitive type — so a
// hand-crafted POST cannot inject arbitrary config into chain.json.
function sanitizeRoute(category: Category, input: unknown): Route | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const out: Route = {};
  for (const k of ['model', 'baseUrl', 'envKey'] as const) {
    if (typeof o[k] === 'string' && o[k]) out[k] = o[k];
  }
  if (category === 'longContext' && typeof o.threshold === 'number' && Number.isFinite(o.threshold)) {
    out.threshold = o.threshold;
  }
  if (category === 'image') {
    if (o.mode === 'auto' || o.mode === 'ocr' || o.mode === 'vision-route' || o.mode === 'off') out.mode = o.mode;
    if (typeof o.dropImage === 'boolean') out.dropImage = o.dropImage;
    for (const k of ['ocrCommand', 'ocrLang'] as const) {
      if (typeof o[k] === 'string' && o[k]) out[k] = o[k];
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function sanitizeRoutes(input: unknown): Routes {
  const out: Routes = {};
  if (!input || typeof input !== 'object') return out;
  const o = input as Record<string, unknown>;
  for (const cat of CATEGORIES) {
    const cleaned = sanitizeRoute(cat, o[cat]);
    if (cleaned) out[cat] = cleaned;
  }
  return out;
}

function readChain(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function readRoutes(path: string = configPath()): Routes {
  const chain = readChain(path);
  const mr = chain.modelRouter as Record<string, unknown> | undefined;
  return sanitizeRoutes(mr?.routes);
}

export function writeRoutes(routes: Routes, path: string = configPath()): Routes {
  const clean = sanitizeRoutes(routes);
  const chain = readChain(path);
  const mr = (chain.modelRouter as Record<string, unknown>) ?? {};
  mr.routes = clean;
  chain.modelRouter = mr;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(chain, null, 2));
  return clean;
}
