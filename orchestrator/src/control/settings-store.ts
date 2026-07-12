// Read/write the editable slice of chain.json (~/.shuba/chain.json) for the
// console Settings view. chain.json holds no secrets — only `envKey` names that
// point at environment variables — so every field here is safe to show/edit.
// The stages read their config at launch, so edits persist but need a
// `shuba run` restart to take effect (the console flags this).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from '../config.ts';
import { sanitizeRoutes } from './routes-store.ts';

type Dict = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

// pick copies the listed keys from src using the given coercer, dropping
// undefined results, so partial/blank fields simply don't get written.
function pick(src: Dict, spec: Record<string, (v: unknown) => unknown>): Dict {
  const out: Dict = {};
  for (const [k, coerce] of Object.entries(spec)) {
    const v = coerce(src[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function nonEmpty(d: Dict): Dict | undefined {
  return Object.keys(d).length > 0 ? d : undefined;
}

// The editable settings surface, section by section.
export type Settings = Dict;

export function sanitizeSettings(input: unknown): Settings {
  const o = (input && typeof input === 'object' ? input : {}) as Dict;
  const out: Settings = {};

  const compactRouter = nonEmpty(pick((o.compactRouter as Dict) ?? {}, { model: str, baseUrl: str, envKey: str }));
  if (compactRouter) out.compactRouter = compactRouter;

  const contextWatchdog = nonEmpty(
    pick((o.contextWatchdog as Dict) ?? {}, {
      model: str,
      baseUrl: str,
      envKey: str,
      thresholdTokens: num,
      tailTurns: num,
    }),
  );
  if (contextWatchdog) out.contextWatchdog = contextWatchdog;

  const rateLimiter = nonEmpty(pick((o.rateLimiter as Dict) ?? {}, { rps: num, burst: num, cooldownMs: num }));
  if (rateLimiter) out.rateLimiter = rateLimiter;

  const imageShrink = nonEmpty(
    pick((o.imageShrink as Dict) ?? {}, {
      scale: (v) => str(v) ?? num(v),
      minBytes: num,
    }),
  );
  if (imageShrink) out.imageShrink = imageShrink;

  const routes = sanitizeRoutes((o.modelRouter as Dict)?.routes);
  if (Object.keys(routes).length > 0) out.modelRouter = { routes };

  const del = (o.delegate as Dict) ?? {};
  const delDefault = nonEmpty(pick((del.default as Dict) ?? {}, { harness: str, model: str }));
  const delegate = pick(del, { classifierModel: str, baseUrl: str, envKey: str, concurrency: num, isolation: str });
  if (delDefault) delegate.default = delDefault;
  if (Object.keys(delegate).length > 0) out.delegate = delegate;

  const graph = nonEmpty(
    pick((o.graph as Dict) ?? {}, { model: str, autobuild: bool, noMedia: bool, enabled: bool }),
  );
  if (graph) out.graph = graph;

  return out;
}

function readChain(path: string): Dict {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// readSettings returns just the editable sections currently in chain.json.
export function readSettings(path: string = configPath()): Settings {
  return sanitizeSettings(readChain(path));
}

// writeSettings merges the sanitized sections into chain.json, leaving unrelated
// keys (terminal, compressors, ports, toggles, control) untouched.
export function writeSettings(input: unknown, path: string = configPath()): Settings {
  const clean = sanitizeSettings(input);
  const chain = readChain(path);
  for (const [k, v] of Object.entries(clean)) chain[k] = v;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(chain, null, 2));
  return clean;
}
