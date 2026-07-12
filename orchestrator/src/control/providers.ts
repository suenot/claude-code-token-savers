// Provider registry: resolves the `provider` segment of a target (see
// target.ts) to an endpoint + env-var key, so a single-string target like
// `a8e/a8e-1.0-pro` or `openrouter/deepseek/a8e-1.0-pro` fully names where the
// request goes. a8e is the near-free default for third-party models.
//
// bodyModel controls what model name the endpoint actually receives, because
// providers disagree: a local multi-provider router (a8e) routes by the full
// `provider/model` path, OpenRouter wants the path minus its own prefix
// (`deepseek/model`), and native APIs (anthropic/openai/deepseek) want the bare
// model name.

import { parseTarget, type Target } from './target.ts';

export type ProviderInfo = { baseUrl: string; envKey: string; bodyModel: (t: Target) => string };

const dropProvider = (t: Target) => t.modelPath.split('/').slice(1).join('/') || t.model;

export const PROVIDERS: Record<string, ProviderInfo> = {
  // Local link-assistant/router — routes by the full provider/model path.
  a8e: { baseUrl: 'http://localhost:8080/v1', envKey: 'A8E_API_KEY', bodyModel: (t) => t.modelPath },
  // OpenRouter — drop the leading `openrouter/`, keep subprovider/model.
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', bodyModel: dropProvider },
  // Native APIs — bare model name.
  anthropic: { baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY', bodyModel: (t) => t.model },
  deepseek: { baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY', bodyModel: (t) => t.model },
  openai: { baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', bodyModel: (t) => t.model },
};

export type Resolved = { target: Target; model: string; baseUrl?: string; envKey?: string };

// resolveTarget turns a target string into the model name to send plus, when
// the provider is known, the upstream endpoint + key.
export function resolveTarget(raw: string): Resolved {
  const target = parseTarget(raw);
  const info = target.provider ? PROVIDERS[target.provider] : undefined;
  if (info) {
    return { target, model: info.bodyModel(target), baseUrl: info.baseUrl, envKey: info.envKey };
  }
  // Unknown / no provider: send the whole model path, no endpoint override.
  return { target, model: target.modelPath };
}
