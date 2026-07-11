import { spawn as defaultSpawn } from 'node:child_process';
import type { Store } from './store.ts';
import type { HarnessAdapter } from './harnesses.ts';
import { HARNESSES } from './harnesses.ts';
import type { JobRecord } from './types.ts';

export function createRunner(opts: {
  store: Store;
  harnesses?: Record<string, HarnessAdapter>;
  spawnImpl?: typeof import('node:child_process').spawn;
  now?: () => number;
}): {
  run(job: JobRecord): Promise<void>;
} {
  const store = opts.store;
  const harnesses = opts.harnesses ?? HARNESSES;
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  const now = opts.now ?? (() => Date.now());

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

      store.update(job.id, { status: 'running', startedAt: now() });

      await new Promise<void>((resolve) => {
        const child: any = spawnImpl(adapter.bin, args, {
          cwd: job.worktreePath ?? job.cwd,
        } as any);

        child.on('close', (code: number | null) => {
          store.update(job.id, {
            exitCode: code,
            status: code === 0 ? 'done' : 'failed',
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
