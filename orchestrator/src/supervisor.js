import { spawn } from 'node:child_process';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForHealth(
  url,
  { timeoutMs = 15000, intervalMs = 250, fetchImpl = fetch, now = Date.now, sleep = defaultSleep } = {},
) {
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

export async function up(chain, { spawnImpl = spawn, fetchImpl = fetch, healthOpts = {} } = {}) {
  const started = [];
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
    status: () => started.map((s) => ({ id: s.id, pid: s.child.pid, port: s.port })),
  };
}
