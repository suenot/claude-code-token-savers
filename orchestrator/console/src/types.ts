// Typed mirrors of the shapes served by orchestrator/src/control/http.ts.
// Kept loose (optional fields, `unknown` fallbacks) rather than tightly
// coupled to the backend's internal types, since the console only consumes
// JSON over the wire.

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type Job = {
  id: string;
  task?: string;
  harness: string;
  model: string | null;
  status: JobStatus;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  cwd?: string;
  isolation?: 'none' | 'worktree';
  worktreePath?: string;
  error?: string;
};

export type JobStatusResponse =
  | { status: JobStatus; harness: string; model: string | null; elapsed_ms: number | null; tail: string }
  | { error: string };

export type JobResultResponse =
  | { status: JobStatus; result: string; exit_code: number | null; log_path: string }
  | { error: string };

export type DelegateInput = {
  task: string;
  harness?: string;
  model?: string;
  cwd?: string;
  files?: string[];
  isolation?: 'none' | 'worktree';
};

export type DelegateResponse = {
  job_id: string;
  harness_chosen: string;
  model_chosen: string;
};

export type HarnessRow = {
  id: string;
  bin: string;
  installed: boolean;
};

export type ChainStage = {
  id: string;
  port: number;
  healthy: boolean;
};

export type Stats = {
  pxpipe?: unknown;
  headroom?: unknown;
  totals: { saved_pct?: number; events?: number };
};

export type GraphStatus = {
  built: boolean;
  path: string;
  node_count: number;
  last_built: number | null;
  watching: boolean;
};

export type GraphQueryResult = {
  ok: boolean;
  result: string;
};
