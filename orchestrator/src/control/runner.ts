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

      let worktreePath: string | undefined;

      // Best-effort worktree cleanup, callable from any failure path
      // (close handler, error handler, or a pre-spawn throw below). Never
      // throws itself — a failing finalize is logged, not propagated, so it
      // can never prevent the job from reaching a terminal status.
      const finalizeWorktreeSafe = (): void => {
        if (!worktreePath) return;
        try {
          const { diff, removed } = finalizeWorktreeImpl(job.cwd, worktreePath);
          store.appendLog(job.id, `\n--- worktree diff (removed=${removed}) ---\n${diff}\n`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          store.appendLog(job.id, `\n--- finalize worktree error ---\n${message}\n`);
        }
      };

      try {
        const args = adapter.buildArgs(job.task, {
          model: job.model ?? undefined,
          files: (job as any).files,
        });

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
            // finalizeWorktreeSafe() never throws, so resolve() below is
            // always reached — a failing git op here used to abort the
            // handler before resolve(), leaving the job stuck and the
            // engine slot leaked forever.
            finalizeWorktreeSafe();
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
            // Spawn failed after a worktree was already created — clean it
            // up too, same as the close-handler path.
            finalizeWorktreeSafe();
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
      } catch (err) {
        // Pre-spawn failure (e.g. createWorktree threw because job.cwd isn't
        // a git repo, or adapter.buildArgs threw) — this used to happen
        // before the 'running' status update, leaving the job stuck at
        // 'queued' with no error/terminal status. Mark it failed here, and
        // clean up a worktree if one was created before the throw.
        const message = err instanceof Error ? err.message : String(err);
        store.appendLog(job.id, `\n--- pre-spawn error ---\n${message}\n`);
        finalizeWorktreeSafe();
        store.update(job.id, {
          status: 'failed',
          error: message,
          endedAt: now(),
        });
      }
    },
  };
}
