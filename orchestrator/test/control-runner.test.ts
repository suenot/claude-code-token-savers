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

test('outcome: keep — non-worktree job exits 0', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none' } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('hi\n', 0) as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'keep');
});

test('outcome: keep — worktree job exits 0 with a non-empty diff (removed=false)', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'diff --git a b', removed: false })) as any;
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'keep');
});

test('outcome: no-change — worktree job exits 0 but diff was empty (removed=true)', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: '', removed: true })) as any;
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.status, 'done');
  assert.equal(store.get(job.id)!.outcome, 'no-change');
});

test('outcome: discard — nonzero exit', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none' } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 2) as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'discard');
});

test('outcome: crash — spawn error', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none' } as any);
  const spawnErrorImpl = () => {
    const child: any = new EventEmitter();
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  };
  const runner = createRunner({ store, spawnImpl: spawnErrorImpl as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'crash');
});

test('outcome: crash — pre-spawn throw (createWorktree throws)', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/not-a-repo', isolation:'worktree' } as any);
  const createWorktreeImpl = (() => { throw new Error('fatal: not a git repository'); }) as any;
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, createWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'crash');
});

test('scope respected — all changed files inside globs → keep', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree', scope:['src/**','test/**'] } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'd', removed: false, files: ['src/a.ts', 'test/a.test.ts'] })) as any;
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.status, 'done');
  assert.equal(store.get(job.id)!.outcome, 'keep');
});

test('scope violation — a changed file matches no glob → scope-violation + offending paths logged', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree', scope:['src/**'] } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'd', removed: false, files: ['src/a.ts', 'secrets/creds.env'] })) as any;
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  // status stays 'done' — outcome is the verdict layer, not a hard failure.
  assert.equal(store.get(job.id)!.status, 'done');
  assert.equal(store.get(job.id)!.outcome, 'scope-violation');
  assert.match(store.readLog(job.id), /scope violation/);
  assert.match(store.readLog(job.id), /secrets\/creds\.env/);
});

test('no scope → keep (back-compat)', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'd', removed: false, files: ['anywhere/x.ts'] })) as any;
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'keep');
});

test('non-worktree job + scope → warning logged, outcome unchanged (keep)', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none', scope:['src/**'] } as any);
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'keep');
  assert.match(store.readLog(job.id), /scope set but unverifiable/);
});

// A spawnSync double: records the call and returns a canned result.
function fakeSpawnSync(result: any) {
  const calls: any[] = [];
  const impl = (cmd: string, opts: any) => {
    calls.push({ cmd, opts });
    return result;
  };
  return { impl, calls };
}

test('validate passes (exit 0) → keep; header logged', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree', validate:'bun test' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'd', removed: false, files: ['src/a.ts'] })) as any;
  const { impl } = fakeSpawnSync({ status: 0, stdout: 'ok\n', stderr: '' });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, spawnSyncImpl: impl as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'keep');
  assert.match(store.readLog(job.id), /--- validate: bun test ---/);
});

test('validate fails (nonzero exit) → discard; header + reason logged, status stays done', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree', validate:'bun test' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'd', removed: false, files: ['src/a.ts'] })) as any;
  const { impl } = fakeSpawnSync({ status: 1, stdout: '', stderr: 'boom\n' });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, spawnSyncImpl: impl as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.status, 'done');
  assert.equal(store.get(job.id)!.outcome, 'discard');
  assert.match(store.readLog(job.id), /--- validate: bun test ---/);
  assert.match(store.readLog(job.id), /validate failed: exit 1/);
});

test('validate spawn failure/timeout (result.error) → discard', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree', validate:'bun test' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'd', removed: false, files: ['src/a.ts'] })) as any;
  const { impl } = fakeSpawnSync({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: new Error('spawnSync bun test ETIMEDOUT') });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, spawnSyncImpl: impl as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'discard');
  assert.match(store.readLog(job.id), /validate failed: spawnSync bun test ETIMEDOUT/);
});

test('no validate → outcome unchanged (keep), validate not invoked', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'd', removed: false, files: ['src/a.ts'] })) as any;
  const { impl, calls } = fakeSpawnSync({ status: 0, stdout: '', stderr: '' });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, spawnSyncImpl: impl as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'keep');
  assert.equal(calls.length, 0);
});

test('validate skipped on no-change (empty diff), validate not invoked', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree', validate:'bun test' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: '', removed: true, files: [] })) as any;
  const { impl, calls } = fakeSpawnSync({ status: 0, stdout: '', stderr: '' });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, spawnSyncImpl: impl as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'no-change');
  assert.equal(calls.length, 0);
});

test('validate runs in the worktree path when isolated (cwd passed to spawnSync)', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'worktree', validate:'bun test' } as any);
  const createWorktreeImpl = (() => ({ path: '/repo/.shuba-worktrees/x' })) as any;
  const finalizeWorktreeImpl = (() => ({ diff: 'd', removed: false, files: ['src/a.ts'] })) as any;
  const { impl, calls } = fakeSpawnSync({ status: 0, stdout: '', stderr: '' });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, spawnSyncImpl: impl as any, createWorktreeImpl, finalizeWorktreeImpl });
  await runner.run(store.get(job.id)!);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'bun test');
  assert.equal(calls[0].opts.cwd, '/repo/.shuba-worktrees/x');
  assert.equal(calls[0].opts.shell, true);
});

test('validate runs in job.cwd for a non-worktree job', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/r', isolation:'none', validate:'bun test' } as any);
  const { impl, calls } = fakeSpawnSync({ status: 0, stdout: '', stderr: '' });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, spawnSyncImpl: impl as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.outcome, 'keep');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.cwd, '/r');
});

// A worktree ExecImpl double: dispatches canned output per git subcommand.
function fakeExec(map: Record<string, string | (() => string)>) {
  const calls: string[][] = [];
  const impl = (file: string, args: string[], _opts: { cwd: string }) => {
    calls.push([file, ...args]);
    const key = args[0];
    const v = map[key];
    if (v === undefined) throw new Error(`unexpected git ${key}`);
    return typeof v === 'function' ? v() : v;
  };
  return { impl, calls };
}

test('snapshot captured — commit sha, clean tree, tracked-file count', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'none' } as any);
  const { impl } = fakeExec({
    'rev-parse': 'abc123\n',
    'status': '',                 // clean
    'ls-files': 'a.ts\nb.ts\nc.ts\n',
  });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, execImpl: impl as any });
  await runner.run(store.get(job.id)!);
  const snap = store.get(job.id)!.snapshot!;
  assert.equal(snap.commit, 'abc123');
  assert.equal(snap.dirty, false);
  assert.equal(snap.files, 3);
});

test('snapshot dirty detection — non-empty porcelain → dirty true', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/repo', isolation:'none' } as any);
  const { impl } = fakeExec({
    'rev-parse': 'deadbeef\n',
    'status': ' M a.ts\n?? new.ts\n',
    'ls-files': 'a.ts\n',
  });
  const runner = createRunner({ store, spawnImpl: fakeSpawn('', 0) as any, execImpl: impl as any });
  await runner.run(store.get(job.id)!);
  assert.equal(store.get(job.id)!.snapshot!.dirty, true);
});

test('snapshot git failure → job still runs, snapshot absent, log line present', async () => {
  const store = createStore({ dir: mkdtempSync(join(tmpdir(),'r-')), now: () => 7 });
  const job = store.create({ id:'', task:'t', harness:'gemini', model:null, cwd:'/not-a-repo', isolation:'none' } as any);
  const impl = (() => { throw new Error('fatal: not a git repository'); }) as any;
  const runner = createRunner({ store, spawnImpl: fakeSpawn('hi\n', 0) as any, execImpl: impl });
  await runner.run(store.get(job.id)!);
  const done = store.get(job.id)!;
  assert.equal(done.status, 'done');            // job ran regardless
  assert.equal(done.snapshot, undefined);
  assert.match(store.readLog(job.id), /snapshot skipped/);
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
