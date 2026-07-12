import { spawn as defaultSpawn, spawnSync as defaultSpawnSync } from 'node:child_process';
import type { Store } from './store.ts';
import type { HarnessAdapter } from './harnesses.ts';
import { HARNESSES } from './harnesses.ts';
import type { JobRecord, JobOutcome } from './types.ts';
import { createWorktree, finalizeWorktree } from './worktree.ts';

// Files matching none of the scope globs. A file is in scope if any glob
// matches it (globs are relative to job.cwd, same as the changed paths git
// reports). Bun.Glob is built in — no extra dependency.
function filesOutsideScope(files: string[], scope: string[]): string[] {
  const globs = scope.map((g) => new Bun.Glob(g));
  return files.filter((f) => !globs.some((glob) => glob.match(f)));
}

// Cap on the validate command so a hung test/lint suite can't wedge the engine
// slot forever. spawnSync enforces this itself (SIGTERM on expiry).
const VALIDATE_TIMEOUT_MS = 5 * 60 * 1000;

export function createRunner(opts: {
  store: Store;
  harnesses?: Record<string, HarnessAdapter>;
  spawnImpl?: typeof import('node:child_process').spawn;
  spawnSyncImpl?: typeof import('node:child_process').spawnSync;
  now?: () => number;
  createWorktreeImpl?: typeof createWorktree;
  finalizeWorktreeImpl?: typeof finalizeWorktree;
}): {
  run(job: JobRecord): Promise<void>;
} {
  const store = opts.store;
  const harnesses = opts.harnesses ?? HARNESSES;
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  const spawnSyncImpl = opts.spawnSyncImpl ?? defaultSpawnSync;
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
      // can never prevent the job from reaching a terminal status. Returns the
      // finalize info (removed=true means the diff was empty) so the caller can
      // classify the outcome; returns undefined when there was no worktree or
      // finalize threw, both of which we treat as "not removed".
      const finalizeWorktreeSafe = (): { removed: boolean; files: string[] } | undefined => {
        if (!worktreePath) return undefined;
        try {
          const { diff, removed, files } = finalizeWorktreeImpl(job.cwd, worktreePath);
          store.appendLog(job.id, `\n--- worktree diff (removed=${removed}) ---\n${diff}\n`);
          return { removed, files };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          store.appendLog(job.id, `\n--- finalize worktree error ---\n${message}\n`);
          return undefined;
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
            const finalized = finalizeWorktreeSafe();
            // A clean exit whose worktree diff was empty (removed=true)
            // produced nothing worth keeping — classify it 'no-change' so the
            // eval loop can tell it apart from a real 'keep'.
            let outcome: JobOutcome =
              code !== 0
                ? 'discard'
                : finalized?.removed
                  ? 'no-change'
                  : 'keep';
            // Write-scope gate (clean exits only). We can only verify what the
            // job wrote when it ran in an isolated worktree — that's the only
            // path that gives us the changed-file list. A non-worktree job with
            // a scope is unverifiable, so we warn rather than invent a verdict.
            const scope = job.scope;
            if (outcome === 'keep' && scope && scope.length > 0) {
              if (finalized) {
                const offenders = filesOutsideScope(finalized.files, scope);
                if (offenders.length > 0) {
                  outcome = 'scope-violation';
                  store.appendLog(
                    job.id,
                    `\n--- scope violation: ${offenders.length} file(s) outside scope [${scope.join(', ')}] ---\n${offenders.join('\n')}\n`,
                  );
                }
              } else {
                store.appendLog(
                  job.id,
                  `\n--- scope set but unverifiable (non-worktree job); scope [${scope.join(', ')}] not enforced ---\n`,
                );
              }
            }
            // Deterministic validate step (clean exits that survived the scope
            // gate only — 'no-change' has nothing to validate and already
            // removed its worktree). The harness succeeding is not proof the
            // change is good; validate is the verdict layer. Runs in the
            // worktree (still present because a 'keep' job has removed=false) or
            // job.cwd for non-worktree jobs. A nonzero exit, timeout, or spawn
            // failure downgrades the outcome to 'discard' but leaves status
            // 'done' — the harness itself did finish.
            if (outcome === 'keep' && job.validate) {
              const cmd = job.validate;
              const result = spawnSyncImpl(cmd, {
                cwd: worktreePath ?? job.cwd,
                shell: true,
                encoding: 'utf8',
                timeout: VALIDATE_TIMEOUT_MS,
              });
              const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
              store.appendLog(job.id, `\n--- validate: ${cmd} ---\n${out}\n`);
              if (result.error) {
                // spawn failure or timeout (SIGTERM) — either way, unvalidated.
                outcome = 'discard';
                store.appendLog(job.id, `\n--- validate failed: ${result.error.message} ---\n`);
              } else if (result.status !== 0) {
                outcome = 'discard';
                const why = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
                store.appendLog(job.id, `\n--- validate failed: ${why} ---\n`);
              }
            }
            store.update(job.id, {
              exitCode: code,
              status: code === 0 ? 'done' : 'failed',
              outcome,
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
              outcome: 'crash',
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
          outcome: 'crash',
          error: message,
          endedAt: now(),
        });
      }
    },
  };
}
