export type BuildContext = {
  port: number;
  upstreamBase?: string;
  provider?: string;
  config?: Config;
};

export type BuildResult = { args: string[]; env: Record<string, string> };

export type StageDescriptor = {
  id: string;
  bin: string;
  defaultPort: number;
  dialect: 'anthropic' | 'translates';
  terminal: boolean;
  healthPath: string;
  builtin?: boolean;
  requiresToken?: boolean;
  clientPathSuffix?: string;
  build(ctx: BuildContext): BuildResult;
};

export type DelegateConfig = {
  concurrency?: number;
  isolation?: 'none' | 'worktree';
  // A delegate target is a single string: harness/provider/[subprovider/]model,
  // e.g. opencode/a8e/a8e-1.0-pro. The legacy object form is still accepted.
  default: string | { harness: string; provider?: string; subprovider?: string; model: string };
  policy?: Array<{ when: string; harness: string; model: string }>;
  baseUrl?: string;
  classifierModel?: string;
  envKey?: string;
};

export type Config = {
  terminal: string;
  compressors: string[];
  ports?: Record<string, number>;
  compactRouter?: { model?: string; baseUrl?: string; envKey?: string };
  contextWatchdog?: {
    model?: string; baseUrl?: string; envKey?: string;
    thresholdTokens?: number; tailTurns?: number;
  };
  rateLimiter?: { rps?: number; burst?: number; cooldownMs?: number };
  crush?: { threshold?: number; budget?: number; enabled?: boolean };
  imageShrink?: { scale?: number | string; minBytes?: number };
  modelRouter?: {
    routes?: {
      default?: { model?: string; baseUrl?: string; envKey?: string };
      background?: { model?: string; baseUrl?: string; envKey?: string };
      think?: { model?: string; baseUrl?: string; envKey?: string };
      longContext?: { model?: string; baseUrl?: string; envKey?: string; threshold?: number };
      webSearch?: { model?: string; baseUrl?: string; envKey?: string };
      image?: {
        model?: string; baseUrl?: string; envKey?: string;
        mode?: 'auto' | 'ocr' | 'vision-route' | 'off'; dropImage?: boolean; ocrCommand?: string; ocrLang?: string;
      };
    };
  };
  delegate?: DelegateConfig;
  control?: { enabled?: boolean };
  graph?: { model?: string; autobuild?: boolean; noMedia?: boolean; enabled?: boolean };
  toggles?: Record<string, boolean>;
};

export type PlannedStage = {
  id: string;
  port: number;
  baseUrl: string;
  upstreamBase?: string;
  provider?: string;
  healthUrl: string;
  spawn: { bin: string; args: string[]; env: Record<string, string> };
};

export type PlanResult =
  | { ok: true; chain: PlannedStage[]; sidecars: PlannedStage[]; head: { baseUrl: string; requiresToken: boolean } }
  | { ok: false; errors: string[] };

export type ChainHandle = {
  down(): Promise<void>;
  status(): Array<{ id: string; pid: number | undefined; port: number }>;
};
