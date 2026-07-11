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
  readerConstraint?: string;
  clientPathSuffix?: string;
  build(ctx: BuildContext): BuildResult;
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
  | { ok: true; chain: PlannedStage[]; head: { baseUrl: string; requiresToken: boolean } }
  | { ok: false; errors: string[] };

export type ChainHandle = {
  down(): Promise<void>;
  status(): Array<{ id: string; pid: number | undefined; port: number }>;
};
