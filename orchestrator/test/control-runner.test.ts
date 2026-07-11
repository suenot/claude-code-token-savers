import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/control/store.ts';
import { createRunner } from '../src/control/runner.ts';

function fakeSpawn(stdout: string, code: number) {
  return () => {
    const child: any = new EventEmitter();
    child.stdout = Readable.from([stdout]);
    child.stderr = Readable.from([]);
    queueMicrotask(() => child.stdout.on('end', () => child.emit('close', code)));
    return child;
  };
}

test('successful job → done, exitCode 0, stdout logged', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none' } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('hello\n', 0) as any, now: () => 9 });
  await runner.run(store.get(job.id)!);
  const done = store.get(job.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.exitCode, 0);
  assert.equal(done.endedAt, 9);
  assert.match(store.readLog(job.id), /hello/);
});

test('nonzero exit → failed', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none' } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 2) as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.status, 'failed');
  assert.equal(store.get(job.id)!.exitCode, 2);
});

test('spawn error (bad bin) → resolves, job failed, error recorded', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none' } as any);
  const spawnErrorImpl = () => {
    const child: any = new EventEmitter();
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    // never emits 'close'
    return child;
  };
  const runner = createRunner({ store, spawnImpl: spawnErrorImpl as any, now: () => 9 });

  const result = await Promise.race([
    runner.run(store.get(job.id)!).then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
  ]);

  assert.equal(result, 'resolved');
  const finished = store.get(job.id)!;
  assert.equal(finished.status, 'failed');
  assert.match(finished.error ?? '', /spawn ENOENT/);
});

test('unknown harness → failed with error', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'nope', model:null, cwd:'/r', isolation:'none' } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.status, 'failed');
  assert.match(store.get(job.id)!.error ?? '', /unknown harness/i);
});

test('createWorktree throws (cwd not a git repo) → job failed (terminal), run() resolves, never stuck at queued', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(), 'r-')), now: () => 7 });
  const job = store.create({
    id: '', task: 't', harness: 'gemini', model: null, cwd: '/not-a-repo', isolation: 'worktree',
  } as any);
  const createWorktreeImpl = (() => {
    throw new Error('fatal: not a git repository');
  }) as any;
  const runner = createRunner({
    store,
    spawnImpl: fakeSpawn('should never run', 0) as any,
    createWorktreeImpl,
    now: () => 9,
  });

  const result = await Promise.race([
    runner.run(store.get(job.id)!).then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
  ]);

  assert.equal(result, 'resolved');
  const finished = store.get(job.id)!;
  assert.equal(finished.status, 'failed');
  assert.equal(finished.endedAt, 9);
  assert.match(finished.error ?? '', /not a git repository/);
});

test('finalizeWorktree throws on close → run() still resolves, job terminal, error logged', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(), 'r-')), now: () => 7 });
  const job = store.create({
    id: '', task: 't', harness: 'gemini', model: null, cwd: '/repo', isolation: 'worktree',
  } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => {
    throw new Error('fatal: worktree diff failed');
  }) as any;
  const runner = createRunner({
    store,
    spawnImpl: fakeSpawn('hello\n', 0) as any,
    createWorktreeImpl,
    finalizeWorktreeImpl,
    now: () => 9,
  });

  const result = await Promise.race([
    runner.run(store.get(job.id)!).then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
  ]);

  assert.equal(result, 'resolved');
  const finished = store.get(job.id)!;
  assert.equal(finished.status, 'done');
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.endedAt, 9);
  assert.match(store.readLog(job.id), /finalize worktree error/);
  assert.match(store.readLog(job.id), /worktree diff failed/);
});
