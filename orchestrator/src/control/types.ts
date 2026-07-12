export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

// A finer-grained verdict on what a finished job produced, orthogonal to the
// coarse done/failed status. Feeds the eval loop (inspired by the Meta-Harness
// paper). 'timeout' is reserved for upcoming per-job timeout support and is
// not emitted yet.
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
  // Allowed path globs (relative to cwd), e.g. ["src/**", "test/**"]. When set,
  // the write-scope gate flags a clean run 'scope-violation' if it changed any
  // file matching none of these globs. Absent/empty = no restriction.
  scope?: string[];
  // Shell command (e.g. "bun test", "npm run lint") run after the harness
  // finishes a clean, in-scope, changed run. Nonzero exit downgrades the
  // outcome to 'discard'. Absent = no validation.
  validate?: string;
  // Compact pre-run state of the source repo (job.cwd), captured just before
  // the harness spawns — an audit/repro aid, deliberately not a full file/SHA
  // manifest so the job JSON stays small. Absent when cwd isn't a git repo or
  // any git command failed.
  snapshot?: { commit: string; dirty: boolean; files: number };
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
  scope?: string[];
  validate?: string;
};
