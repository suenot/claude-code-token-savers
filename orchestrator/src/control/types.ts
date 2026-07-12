export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

// A finer-grained verdict on what a finished job produced, orthogonal to the
// coarse done/failed status. Feeds the eval loop (inspired by the Meta-Harness
// paper). 'timeout' and 'scope-violation' are reserved for upcoming features —
// per-job timeout support and the write-scope gate — and are not emitted yet.
export type JobOutcome =
  | 'keep'
  | 'discard'
  | 'crash'
  | 'timeout'
  | 'no-change'
  | 'scope-violation';

export type JobRecord = {
  id: string;
  task: string;
  harness: string;
  model: string | null;
  cwd: string;
  isolation: 'none' | 'worktree';
  status: JobStatus;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  outcome?: JobOutcome;
  worktreePath?: string;
  error?: string;
};

export type DelegateInput = {
  task: string;
  harness?: string;
  model?: string;
  cwd?: string;
  files?: string[];
  isolation?: 'none' | 'worktree';
};
