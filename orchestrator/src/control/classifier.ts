import type { DelegateInput } from './types.ts';
import { HARNESSES } from './harnesses.ts';
import { parseTarget } from './target.ts';
import { resolveTarget } from './providers.ts';
import type { DelegateConfig } from '../types.ts';

export type { DelegateConfig } from '../types.ts';

// Loosened to the subset actually used (`.ok` / `.json()`), so test doubles
// that return a plain object don't typecheck against the full global `fetch`
// signature (which also carries static members like `preconnect`).
type FetchLike = (
  url: string,
  init?: Record<string, unknown>
) => Promise<{ ok?: boolean; json?: () => Promise<any> }>;

type ClassifierResult = { harness: string; model: string } | null;

async function classify(
  input: DelegateInput,
  cfg: DelegateConfig,
  opts: { fetchImpl?: FetchLike; apiKey?: string }
): Promise<ClassifierResult> {
  if (!cfg.policy || cfg.policy.length === 0) {
    return null;
  }

  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  // classifierModel is a target string (provider/model); resolve it to the
  // endpoint + model the classifier LLM call should use.
  const t = resolveTarget(cfg.classifierModel ?? 'a8e/a8e-1.0-pro');
  const baseUrl = cfg.baseUrl ?? t.baseUrl ?? 'http://localhost:8080/v1';
  const model = t.model || 'a8e/a8e-1.0-pro';

  const hints = cfg.policy
    .map((p) => `- when: "${p.when}" -> harness: "${p.harness}", model: "${p.model}"`)
    .join('\n');

  const userMessage = `Task: "${input.task}"

Policy hints (choose the closest match, or the most sensible default if none match):
${hints}

Respond with ONLY a strict JSON object of the form {"harness":"<harness>","model":"<model>"} and nothing else.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey ?? ''}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    } as any);

    if (!res || !(res as any).ok) {
      return null;
    }

    const data: any = await (res as any).json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    if (
      !parsed ||
      typeof parsed.harness !== 'string' ||
      typeof parsed.model !== 'string' ||
      !(parsed.harness in HARNESSES)
    ) {
      return null;
    }

    return { harness: parsed.harness, model: parsed.model };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// composeModel joins a delegate target's provider/subprovider/model into the
// single model path a harness expects (e.g. opencode's `-m` flag). Blank parts
// are dropped, so a config with only `model` still yields just the model.
export function composeModel(t: { provider?: string; subprovider?: string; model?: string }): string {
  return [t.provider, t.subprovider, t.model].filter((v): v is string => typeof v === 'string' && v.length > 0).join('/');
}

// defaultTarget flattens cfg.default to the {harness, model} pair the runner
// consumes. cfg.default may be a single-string target
// (harness/provider/subprovider/model) or the legacy object form.
function defaultTarget(cfg: DelegateConfig): { harness: string; model: string } {
  const d = cfg.default as unknown;
  if (typeof d === 'string') {
    const t = parseTarget(d);
    return { harness: t.harness ?? 'opencode', model: t.modelPath };
  }
  const obj = d as { harness: string; provider?: string; subprovider?: string; model: string };
  return { harness: obj.harness, model: composeModel(obj) };
}

export async function selectHarnessModel(
  input: DelegateInput,
  cfg: DelegateConfig,
  opts?: { fetchImpl?: FetchLike; apiKey?: string }
): Promise<{ harness: string; model: string }> {
  if (input.harness !== undefined && input.model !== undefined) {
    return { harness: input.harness, model: input.model };
  }

  const fallback = defaultTarget(cfg);

  if (input.harness === undefined && input.model === undefined) {
    const result = await classify(input, cfg, opts ?? {});
    return result ?? fallback;
  }

  // Exactly one of harness/model is set: fill the missing one.
  const result = await classify(input, cfg, opts ?? {});
  return {
    harness: input.harness ?? result?.harness ?? fallback.harness,
    model: input.model ?? result?.model ?? fallback.model,
  };
}
