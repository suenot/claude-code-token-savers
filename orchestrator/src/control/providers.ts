// Provider registry: resolves the `provider` segment of a target (see
// target.ts) to an endpoint + env-var key, so a single-string target like
// `a8e/a8e-1.0-pro` or `openrouter/deepseek/a8e-1.0-pro` fully names where the
// request goes. a8e is the near-free default for third-party models.

import { parseTarget, type Target } from './target.ts';

export type ProviderInfo = { baseUrl: string; envKey: string };

export const PROVIDERS: Record<string, ProviderInfo> = {
  a8e: { baseUrl: 'http://localhost:8080/v1', envKey: 'A8E_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY' },
  anthropic: { baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY' },
};

export type Resolved = {
  target: Target;
  // body.model to send: the model path with a KNOWN provider prefix stripped
  // (the provider is expressed by the endpoint, not the model name).
  model: string;
  baseUrl?: string;
  envKey?: string;
};

// resolveTarget turns a target string into what a proxy route needs: the
// body.model plus, when the provider is known, the upstream endpoint + key.
export function resolveTarget(raw: string): Resolved {
  const target = parseTarget(raw);
  const provider = target.provider;
  const info = provider ? PROVIDERS[provider] : undefined;
  if (info) {
    // Drop the provider segment; the rest (subprovider/model) is body.model.
    const model = target.modelPath.split('/').slice(1).join('/') || target.model;
    return { target, model, baseUrl: info.baseUrl, envKey: info.envKey };
  }
  // Unknown/no provider: send the whole model path as-is, no endpoint override.
  return { target, model: target.modelPath };
}
