import { spawn } from 'node:child_process';
import type { ChainHandle, PlannedStage } from './types.ts';

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Loosened to the subset actually used (`.ok`), so test doubles that return a
// plain `{ ok }` object without a full Response typecheck against this param.
type FetchLike = (url: string) => Promise<{ ok: boolean }>;

// Loosened to the subset actually used (`.pid` / `.kill(...)`), so test
// doubles standing in for a ChildProcess typecheck against this param.
type SpawnedProcess = { pid?: unknown; kill(signal?: unknown): unknown };
type SpawnLike = (
  bin: string,
  args: string[],
  opts: Record<string, unknown>,
) => SpawnedProcess;

export async function waitForHealth(
  url: string,
  {
    timeoutMs = 15000,
    intervalMs = 250,
    fetchImpl = fetch as FetchLike,
    now = Date.now,
    sleep = defaultSleep,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: FetchLike;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<void> {
  const start = now();
  for (;;) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (now() - start >= timeoutMs) {
      throw new Error(`health check timed out for ${url}`);
    }
    await sleep(intervalMs);
  }
}

export async function up(
  chain: PlannedStage[],
  {
    spawnImpl = spawn as unknown as SpawnLike,
    fetchImpl = fetch as FetchLike,
    healthOpts = {},
  }: {
    spawnImpl?: SpawnLike;
    fetchImpl?: FetchLike;
    healthOpts?: Record<string, unknown>;
  } = {},
): Promise<ChainHandle> {
  const started: Array<{ id: string; port: number; child: SpawnedProcess }> = [];
  const down = async () => {
    for (const s of [...started].reverse()) {
      try {
        s.child.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
  };
  try {
    for (const stage of chain) {
      const child = spawnImpl(stage.spawn.bin, stage.spawn.args, {
        env: { ...process.env, ...stage.spawn.env },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      started.push({ id: stage.id, port: stage.port, child });
      await waitForHealth(stage.healthUrl, { ...healthOpts, fetchImpl });
    }
  } catch (err) {
    await down();
    throw err;
  }
  return {
    down,
    status: () => started.map((s) => ({ id: s.id, pid: s.child.pid as number | undefined, port: s.port })),
  };
}
