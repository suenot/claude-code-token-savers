import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/control/store.ts';
import { createEngine } from '../src/control/engine.ts';

const cfg = { concurrency: 2, default: { harness: 'opencode', model: 'm' } };

function gatedRunner() {
  const gates: Array<() => void> = [];
  return {
    running: 0, max: 0,
    run(job: any) {
      this.running++; this.max = Math.max(this.max, this.running);
      return new Promise<void>((res) => gates.push(() => { this.running--; res(); }));
    },
    releaseOne() { gates.shift()?.(); },
  };
}

test('delegate returns chosen harness/model immediately; concurrency capped', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'e-')), now: () => 1 });
  const runner: any = gatedRunner();
  const select = (async () => ({ harness: 'opencode', model: 'm' })) as any;
  const engine = createEngine({ cfg: cfg as any, store, runner, select, projectCwd: '/r' });
  const a = await engine.delegate({ task: '1' });
  const b = await engine.delegate({ task: '2' });
  const c = await engine.delegate({ task: '3' });
  assert.equal(a.harness_chosen, 'opencode');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(runner.max <= 2, `max concurrency ${runner.max} must be <= 2`);
  assert.equal((engine.status(c.job_id) as any).status, 'queued');
  runner.releaseOne();
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual((engine.status(c.job_id) as any).status, 'queued');
});

test('status/result on unknown id → error', () => {
  const engine = createEngine({ cfg: cfg as any, store: createStore({ dir: mkdtempSync(join(tmpdir(),'e-')), now:()=>1 }), runner: gatedRunner() as any, select: (async()=>({harness:'x',model:'m'})) as any, projectCwd: '/r' });
  assert.ok('error' in engine.status('nope'));
  assert.ok('error' in engine.result('nope'));
});
