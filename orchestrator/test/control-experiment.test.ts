import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/control/store.ts';
import { createExperiments } from '../src/control/experiment.ts';
import type { DelegateInput, JobOutcome, JobStatus } from '../src/control/types.ts';

type CandidateSpec = {
  harness: string;
  model?: string;
  outcome?: JobOutcome;
  bytes?: number;      // diffStats.bytes; omit for no diffStats
  endedAt?: number;
  status?: JobStatus;  // default 'done'
};

// Wire an experiments instance to a real store whose candidate jobs are marked
// terminal (with a canned outcome/diffStats) the moment delegate is called, so
// the background poller settles immediately.
function setup(specs: CandidateSpec[]) {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(), 'exp-')), now: () => 1 });
  const calls: DelegateInput[] = [];
  let i = 0;
  const delegate = async (input: DelegateInput) => {
    calls.push(input);
    const spec = specs[i++]!;
    const job = store.create({
      id: '', task: input.task, harness: input.harness!, model: input.model ?? null,
      cwd: input.cwd ?? '/repo', isolation: input.isolation!,
    } as any);
    store.update(job.id, {
      status: spec.status ?? 'done',
      outcome: spec.outcome,
      endedAt: spec.endedAt ?? 100,
      diffStats: spec.bytes != null ? { files: 1, bytes: spec.bytes } : undefined,
    });
    return { job_id: job.id, harness_chosen: input.harness!, model_chosen: input.model ?? 'auto' };
  };
  const experiments = createExperiments({ store, delegate, now: () => 1, pollMs: 1 });
  return { store, experiments, calls };
}

test('run creates one worktree job per variant, sharing scope/validate', async () => {
  const { experiments, calls } = setup([
    { harness: 'gemini', outcome: 'keep', bytes: 10 },
    { harness: 'qwen', outcome: 'keep', bytes: 20 },
  ]);
  const { experiment_id, job_ids } = await experiments.run({
    task: 'do it',
    variants: [{ harness: 'gemini' }, { harness: 'qwen' }],
    cwd: '/repo',
    scope: ['src/**'],
    validate: 'bun test',
  });
  await experiments.join(experiment_id);
  assert.equal(job_ids.length, 2);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.isolation, 'worktree');
    assert.deepEqual(c.scope, ['src/**']);
    assert.equal(c.validate, 'bun test');
    assert.equal(c.cwd, '/repo');
  }
});

test('winner = smallest-diff keep', async () => {
  const { experiments } = setup([
    { harness: 'gemini', outcome: 'keep', bytes: 100 },
    { harness: 'qwen', outcome: 'keep', bytes: 40 },
    { harness: 'claude', outcome: 'keep', bytes: 70 },
  ]);
  const { experiment_id, job_ids } = await experiments.run({
    task: 't',
    variants: [{ harness: 'gemini' }, { harness: 'qwen' }, { harness: 'claude' }],
  });
  await experiments.join(experiment_id);
  const rec = experiments.get(experiment_id)!;
  assert.equal(rec.status, 'done');
  assert.equal(rec.winnerJobId, job_ids[1]);       // the 40-byte candidate
  assert.match(rec.reason, /smallest passing diff \(40 bytes\)/);
});

test('validate-failed candidate (discard) never wins, even with a smaller diff', async () => {
  const { experiments } = setup([
    { harness: 'gemini', outcome: 'keep', bytes: 200 },
    { harness: 'qwen', outcome: 'discard', bytes: 5 },   // tiny but failed a gate
  ]);
  const { experiment_id, job_ids } = await experiments.run({
    task: 't',
    variants: [{ harness: 'gemini' }, { harness: 'qwen' }],
  });
  await experiments.join(experiment_id);
  const rec = experiments.get(experiment_id)!;
  assert.equal(rec.winnerJobId, job_ids[0]);       // the keep, not the discard
});

test('tie on bytes → earliest endedAt wins', async () => {
  const { experiments } = setup([
    { harness: 'gemini', outcome: 'keep', bytes: 50, endedAt: 300 },
    { harness: 'qwen', outcome: 'keep', bytes: 50, endedAt: 150 },
  ]);
  const { experiment_id, job_ids } = await experiments.run({
    task: 't',
    variants: [{ harness: 'gemini' }, { harness: 'qwen' }],
  });
  await experiments.join(experiment_id);
  assert.equal(experiments.get(experiment_id)!.winnerJobId, job_ids[1]);
});

test('all-discard → no winner, reason gives outcome breakdown', async () => {
  const { experiments } = setup([
    { harness: 'gemini', outcome: 'discard', status: 'failed' },
    { harness: 'qwen', outcome: 'no-change' },
  ]);
  const { experiment_id } = await experiments.run({
    task: 't',
    variants: [{ harness: 'gemini' }, { harness: 'qwen' }],
  });
  await experiments.join(experiment_id);
  const rec = experiments.get(experiment_id)!;
  assert.equal(rec.winnerJobId, null);
  assert.match(rec.reason, /no candidate kept/);
  assert.match(rec.reason, /discard=1/);
  assert.match(rec.reason, /no-change=1/);
});

test('status/list read back the persisted JSON', async () => {
  const { experiments } = setup([{ harness: 'gemini', outcome: 'keep', bytes: 10 }]);
  const { experiment_id } = await experiments.run({ task: 't', variants: [{ harness: 'gemini' }] });
  await experiments.join(experiment_id);
  const status = experiments.status(experiment_id);
  assert.ok(!('error' in status));
  const list = experiments.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, experiment_id);
  assert.equal(experiments.status('nope' as any) && (experiments.status('nope') as any).error, 'unknown experiment: nope');
});
