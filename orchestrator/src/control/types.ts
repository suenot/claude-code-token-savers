export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

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
