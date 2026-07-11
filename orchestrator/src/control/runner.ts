import { spawn as defaultSpawn } from 'node:child_process';
import type { Store } from './store.ts';
import type { HarnessAdapter } from './harnesses.ts';
import { HARNESSES } from './harnesses.ts';
import type { JobRecord } from './types.ts';
import { createWorktree, finalizeWorktree } from './worktree.ts';

export function createRunner(opts: {
  store: Store;
  harnesses?: Record<string, HarnessAdapter>;
  spawnImpl?: typeof import('node:child_process').spawn;
  now?: () => number;
  createWorktreeImpl?: typeof createWorktree;
  finalizeWorktreeImpl?: typeof finalizeWorktree;
}): {
  run(job: JobRecord): Promise<void>;
} {
  const store = opts.store;
  const harnesses = opts.harnesses ?? HARNESSES;
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  const now = opts.now ?? (() => Date.now());
  const createWorktreeImpl = opts.createWorktreeImpl ?? createWorktree;
  const finalizeWorktreeImpl = opts.finalizeWorktreeImpl ?? finalizeWorktree;

  return {
    async run(job: JobRecord): Promise<void> {
      const adapter = harnesses[job.harness];
      if (!adapter) {
        store.update(job.id, {
          status: 'failed',
          error: `unknown harness: ${job.harness}`,
        });
        return;
      }

      const args = adapter.buildArgs(job.task, {
        model: job.model ?? undefined,
        files: (job as any).files,
      });

      let worktreePath: string | undefined;
      if (job.isolation === 'worktree') {
        const { path } = createWorktreeImpl(job.cwd, job.id);
        worktreePath = path;
        job = store.update(job.id, { worktreePath: path });
      }

      store.update(job.id, { status: 'running', startedAt: now() });

      await new Promise<void>((resolve) => {
        let settled = false;
        const child: any = spawnImpl(adapter.bin, args, {
          cwd: worktreePath ?? job.cwd,
        } as any);

        child.on('close', (code: number | null) => {
          if (settled) return;
          settled = true;
          if (worktreePath) {
            const { diff, removed } = finalizeWorktreeImpl(job.cwd, worktreePath);
            store.appendLog(job.id, `\n--- worktree diff (removed=${removed}) ---\n${diff}\n`);
          }
          store.update(job.id, {
            exitCode: code,
            status: code === 0 ? 'done' : 'failed',
            endedAt: now(),
          });
          resolve();
        });

        child.on('error', (err: Error) => {
          if (settled) return;
          settled = true;
          store.appendLog(job.id, `\n--- spawn error ---\n${err.message}\n`);
          store.update(job.id, {
            status: 'failed',
            error: err.message,
            endedAt: now(),
          });
          resolve();
        });

        queueMicrotask(() => {
          child.stdout?.on('data', (chunk: Buffer | string) => {
            store.appendLog(job.id, chunk.toString());
          });
          child.stderr?.on('data', (chunk: Buffer | string) => {
            store.appendLog(job.id, chunk.toString());
          });
        });
      });
    },
  };
}
