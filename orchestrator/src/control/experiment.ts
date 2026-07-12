import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.ts';
import type {
  DelegateInput,
  ExperimentInput,
  ExperimentRecord,
  JobRecord,
} from './types.ts';

type DelegateFn = (
  input: DelegateInput,
) => Promise<{ job_id: string; harness_chosen: string; model_chosen: string }>;

export type Experiments = {
  run(input: ExperimentInput): Promise<{ experiment_id: string; job_ids: string[] }>;
  status(id: string): ExperimentRecord | { error: string };
  get(id: string): ExperimentRecord | undefined;
  list(): ExperimentRecord[];
  // Resolves once the experiment's background judging has finished. Returns
  // immediately for unknown ids. Exposed for callers (and tests) that need to
  // wait on a result rather than poll the JSON.
  join(id: string): Promise<void>;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isTerminal(job: JobRecord | undefined): boolean {
  // A missing job counts as terminal so a deleted/never-created candidate can't
  // wedge the poll loop forever.
  return !job || job.status === 'done' || job.status === 'failed';
}

function outcomeCounts(jobs: JobRecord[]): string {
  const tally: Record<string, number> = {};
  for (const j of jobs) {
    const key = j.outcome ?? 'none';
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return Object.entries(tally)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

export function createExperiments(opts: {
  store: Store;
  delegate: DelegateFn;
  now?: () => number;
  pollMs?: number;
}): Experiments {
  const store = opts.store;
  const delegate = opts.delegate;
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 1000;

  const dir = join(store.dir, 'experiments');
  mkdirSync(dir, { recursive: true });

  let counter = 0;
  // id -> the in-flight judging promise, so join() can await it.
  const pending = new Map<string, Promise<void>>();

  function jsonPath(id: string): string {
    return join(dir, `${id}.json`);
  }

  function persist(rec: ExperimentRecord): void {
    writeFileSync(jsonPath(rec.id), JSON.stringify(rec, null, 2));
  }

  function get(id: string): ExperimentRecord | undefined {
    const p = jsonPath(id);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as ExperimentRecord;
  }

  // Poll until every candidate job is terminal, then pick the winner: only
  // 'keep' jobs qualify, and among them the smallest diff (fewest churned
  // bytes that still passed every gate) wins; ties break to the earliest to
  // finish. No keeps → no winner, with the outcome breakdown as the reason.
  async function awaitAndJudge(rec: ExperimentRecord): Promise<void> {
    const ids = rec.candidates.map((c) => c.jobId);
    for (;;) {
      if (ids.map((id) => store.get(id)).every(isTerminal)) break;
      await sleep(pollMs);
    }

    const jobs = ids
      .map((id) => store.get(id))
      .filter((j): j is JobRecord => j !== undefined);
    const keeps = jobs.filter((j) => j.outcome === 'keep');

    let winnerJobId: string | null = null;
    let reason: string;
    if (keeps.length === 0) {
      reason = `no candidate kept a change (${outcomeCounts(jobs)})`;
    } else {
      keeps.sort((a, b) => {
        const ba = a.diffStats?.bytes ?? Number.POSITIVE_INFINITY;
        const bb = b.diffStats?.bytes ?? Number.POSITIVE_INFINITY;
        if (ba !== bb) return ba - bb;
        return (a.endedAt ?? 0) - (b.endedAt ?? 0);
      });
      const winner = keeps[0]!;
      winnerJobId = winner.id;
      reason = `smallest passing diff (${winner.diffStats?.bytes ?? 0} bytes) of ${keeps.length} keep(s)`;
    }

    persist({ ...rec, status: 'done', winnerJobId, reason });
  }

  return {
    async run(input) {
      counter += 1;
      const id = `exp_${now()}_${counter}`;
      const cwd = input.cwd;

      const candidates: ExperimentRecord['candidates'] = [];
      const job_ids: string[] = [];
      for (const variant of input.variants) {
        // Candidates always run in a worktree — they must never touch the real
        // tree, and only worktree jobs yield the diffStats the judge compares.
        const res = await delegate({
          task: input.task,
          harness: variant.harness,
          model: variant.model,
          cwd,
          isolation: 'worktree',
          scope: input.scope,
          validate: input.validate,
        });
        candidates.push({
          jobId: res.job_id,
          harness: res.harness_chosen,
          model: res.model_chosen,
        });
        job_ids.push(res.job_id);
      }

      const rec: ExperimentRecord = {
        id,
        task: input.task,
        cwd: cwd ?? '',
        scope: input.scope,
        validate: input.validate,
        createdAt: now(),
        status: 'running',
        candidates,
        winnerJobId: null,
        reason: '',
      };
      persist(rec);

      // Kick off judging in the background; callers get the ids right away.
      pending.set(
        id,
        awaitAndJudge(rec).finally(() => pending.delete(id)),
      );

      return { experiment_id: id, job_ids };
    },

    status(id) {
      const rec = get(id);
      if (!rec) return { error: `unknown experiment: ${id}` };
      return rec;
    },

    get,

    list() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ExperimentRecord);
    },

    join(id) {
      return pending.get(id) ?? Promise.resolve();
    },
  };
}
