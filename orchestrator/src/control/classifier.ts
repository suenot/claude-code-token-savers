import type { DelegateInput } from './types.ts';
import { HARNESSES } from './harnesses.ts';

// Loosened to the subset actually used (`.ok` / `.json()`), so test doubles
// that return a plain object don't typecheck against the full global `fetch`
// signature (which also carries static members like `preconnect`).
type FetchLike = (
  url: string,
  init?: Record<string, unknown>
) => Promise<{ ok?: boolean; json?: () => Promise<any> }>;

export type DelegateConfig = {
  concurrency?: number;
  isolation?: 'none' | 'worktree';
  default: { harness: string; model: string };
  policy?: Array<{ when: string; harness: string; model: string }>;
  baseUrl?: string;
  classifierModel?: string;
  envKey?: string;
};

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
  const baseUrl = cfg.baseUrl ?? 'https://openrouter.ai/api/v1';
  const model = cfg.classifierModel ?? 'deepseek/deepseek-v4-flash';

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

export async function selectHarnessModel(
  input: DelegateInput,
  cfg: DelegateConfig,
  opts?: { fetchImpl?: FetchLike; apiKey?: string }
): Promise<{ harness: string; model: string }> {
  if (input.harness !== undefined && input.model !== undefined) {
    return { harness: input.harness, model: input.model };
  }

  if (input.harness === undefined && input.model === undefined) {
    const result = await classify(input, cfg, opts ?? {});
    return result ?? cfg.default;
  }

  // Exactly one of harness/model is set: fill the missing one.
  const result = await classify(input, cfg, opts ?? {});
  return {
    harness: input.harness ?? result?.harness ?? cfg.default.harness,
    model: input.model ?? result?.model ?? cfg.default.model,
  };
}
