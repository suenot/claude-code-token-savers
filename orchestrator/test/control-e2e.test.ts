import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/control/store.ts';
import { createRunner } from '../src/control/runner.ts';
import { createEngine } from '../src/control/engine.ts';
import type { HarnessAdapter } from '../src/control/harnesses.ts';

const MARKER = 'ECHOED-HELLO-42';

test('control e2e: delegate -> poll -> result with a fake harness', async () => {
  const scriptDir = mkdtempSync(join(tmpdir(), 'shuba-e2e-bin-'));
  const scriptPath = join(scriptDir, 'fake-echo.sh');
  writeFileSync(scriptPath, `#!/bin/bash\necho "${MARKER}: $*"\n`);
  chmodSync(scriptPath, 0o755);

  const echoHarness: HarnessAdapter = {
    id: 'echo',
    bin: scriptPath,
    buildArgs(task) {
      return [task];
    },
    extractResult(stdout) {
      return stdout.trim();
    },
  };

  const storeDir = mkdtempSync(join(tmpdir(), 'shuba-e2e-store-'));
  const store = createStore({ dir: storeDir });
  const runner = createRunner({ store, harnesses: { echo: echoHarness } });
  const select = (async () => ({ harness: 'echo', model: null })) as any;

  const cfg = { concurrency: 1, default: { harness: 'echo', model: 'm' } };
  const engine = createEngine({
    cfg: cfg as any,
    store,
    runner,
    select,
    projectCwd: process.cwd(),
  });

  const { job_id } = await engine.delegate({ task: 'hello' });

  let status = (engine.status(job_id) as any).status;
  const deadline = Date.now() + 5000;
  while (status !== 'done' && status !== 'failed' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    status = (engine.status(job_id) as any).status;
  }

  assert.equal(status, 'done', `job should complete; last status=${status}`);

  const result = engine.result(job_id) as any;
  assert.equal(result.status, 'done');
  assert.ok(
    typeof result.result === 'string' && result.result.includes(MARKER),
    `result should contain echoed marker, got: ${JSON.stringify(result.result)}`,
  );
});
