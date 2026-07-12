// A "target" is the single-string way to name where a task/request should go:
//
//   [harness/]provider/[subprovider/]model
//
// e.g.  opencode/openrouter/deepseek/a8e-1.0-pro   (delegate: run in opencode)
//        openrouter/deepseek/a8e-1.0-pro           (route: no harness)
//        anthropic/claude-opus-4-8                 (provider + model)
//        claude-haiku-4-5                          (bare model)
//
// The leading segment is a harness ONLY when it matches a known harness id —
// otherwise every segment is part of the provider/model path. This is the one
// format used for delegate defaults and every model-router route.

import { HARNESSES } from './harnesses.ts';

export type Target = {
  raw: string;
  harness?: string;
  provider?: string;
  subprovider?: string;
  model: string;
  // modelPath is everything after the harness (provider/[subprovider/]model),
  // i.e. what a harness's -m flag or a route's body.model wants.
  modelPath: string;
};

export function parseTarget(raw: string, harnessIds: string[] = Object.keys(HARNESSES)): Target {
  const parts = (raw ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { raw, model: '', modelPath: '' };

  let harness: string | undefined;
  let rest = parts;
  if (parts.length >= 2 && harnessIds.includes(parts[0])) {
    harness = parts[0];
    rest = parts.slice(1);
  }

  const model = rest[rest.length - 1];
  const modelPath = rest.join('/');
  // provider/subprovider only make sense when there is a path in front of model.
  const provider = rest.length >= 2 ? rest[0] : undefined;
  const subprovider = rest.length >= 3 ? rest[1] : undefined;

  return { raw, harness, provider, subprovider, model, modelPath };
}
