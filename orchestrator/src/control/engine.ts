import { join } from 'node:path';
import type { Store } from './store.ts';
import { createStore } from './store.ts';
import { createRunner } from './runner.ts';

type Runner = { run(job: import('./types.ts').JobRecord): Promise<void> };
import { HARNESSES, detectHarnesses } from './harnesses.ts';
import { selectHarnessModel, type DelegateConfig } from './classifier.ts';
import { createExperiments, type Experiments } from './experiment.ts';
import type { DelegateInput, ExperimentInput, ExperimentRecord, JobStatus } from './types.ts';

const TAIL_BYTES = 2048;

export function createEngine(opts: {
  cfg: DelegateConfig;
  store?: Store;
  runner?: Runner;
  select?: typeof selectHarnessModel;
  apiKey?: string;
  projectCwd: string;
  now?: () => number;
  experiments?: Experiments;
}): {
  delegate(input: DelegateInput): Promise<{ job_id: string; harness_chosen: string; model_chosen: string }>;
  status(id: string): { status: JobStatus; harness: string; model: string | null; elapsed_ms: number | null; tail: string } | { error: string };
  result(id: string): { status: JobStatus; result: string; exit_code: number | null; log_path: string } | { error: string };
  harnessList(): Array<{ id: string; bin: string; installed: boolean }>;
  listJobs(): ReturnType<Store['list']>;
  experimentRun(input: ExperimentInput): Promise<{ experiment_id: string; job_ids: string[] }>;
  experimentStatus(id: string): ExperimentRecord | { error: string };
  experimentList(): ExperimentRecord[];
} {
  const store = opts.store ?? createStore({});
  const runner = opts.runner ?? createRunner({ store });
  const select = opts.select ?? selectHarnessModel;
  const now = opts.now ?? (() => Date.now());
  const concurrency = opts.cfg.concurrency ?? 3;

  let running = 0;
  const queue: string[] = [];

  function pump(): void {
    while (running < concurrency && queue.length > 0) {
      const id = queue.shift()!;
      let job = store.get(id);
      if (!job) continue;
      running += 1;
      job = store.update(id, { status: 'running' });
      runner
        .run(job)
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  async function delegate(
    input: DelegateInput,
  ): Promise<{ job_id: string; harness_chosen: string; model_chosen: string }> {
    const { harness, model } = await select(input, opts.cfg, { apiKey: opts.apiKey });
    const job = store.create({
      id: '',
      task: input.task,
      harness,
      model,
      cwd: input.cwd ?? opts.projectCwd,
      isolation: input.isolation ?? opts.cfg.isolation ?? 'none',
      scope: input.scope,
      validate: input.validate,
    });
    queue.push(job.id);
    pump();
    return { job_id: job.id, harness_chosen: harness, model_chosen: model };
  }

  // Experiment runner shares this engine's store and delegate path, so its
  // candidate jobs flow through the same queue/concurrency as any other job.
  const experiments = opts.experiments ?? createExperiments({ store, delegate, now });

  return {
    delegate,

    status(id) {
      const job = store.get(id);
      if (!job) return { error: `unknown job: ${id}` };
      const elapsed_ms =
        job.startedAt != null ? (job.endedAt ?? now()) - job.startedAt : null;
      const log = store.readLog(id);
      const tail = log.length > TAIL_BYTES ? log.slice(-TAIL_BYTES) : log;
      return {
        status: job.status,
        harness: job.harness,
        model: job.model,
        elapsed_ms,
        tail,
      };
    },

    result(id) {
      const job = store.get(id);
      if (!job) return { error: `unknown job: ${id}` };
      const log = store.readLog(id);
      const terminal = job.status === 'done' || job.status === 'failed';
      const adapter = HARNESSES[job.harness];
      const result = terminal && adapter ? adapter.extractResult(log) : log;
      return {
        status: job.status,
        result,
        exit_code: job.exitCode,
        log_path: join(store.dir, `${id}.log`),
      };
    },

    harnessList() {
      return detectHarnesses();
    },

    listJobs() {
      return store.list();
    },

    experimentRun(input) {
      return experiments.run(input);
    },

    experimentStatus(id) {
      return experiments.status(id);
    },

    experimentList() {
      return experiments.list();
    },
  };
}
