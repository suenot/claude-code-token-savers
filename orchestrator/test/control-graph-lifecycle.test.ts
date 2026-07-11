import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraph } from '../src/control/graph.ts';

function fakeChild() {
  return { kill: () => {}, killed: false } as unknown as import('node:child_process').ChildProcess;
}

test('ensure: graph present → watch, spawnImpl invoked, status().watching true', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  mkdirSync(join(cwd, 'graphify-out'));
  writeFileSync(join(cwd, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [] }));

  const spawnCalls: Array<{ file: string; args: string[]; opts: unknown }> = [];
  const spawnImpl = (file: string, args: string[], opts: unknown) => {
    spawnCalls.push({ file, args, opts });
    return fakeChild();
  };
  const execFileImpl = () => {
    throw new Error('should not be called: no build expected');
  };

  const graph = createGraph({ cwd, spawnImpl, execFileImpl });
  const result = await graph.ensure();

  assert.deepEqual(result, { action: 'watch' });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]!.file, 'graphify');
  assert.deepEqual(spawnCalls[0]!.args, ['watch', cwd]);
  assert.equal(graph.status().watching, true);
});

test('ensure: no graph + autobuild:false → skipped, no spawn, no build', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));

  let spawnCalled = false;
  let execCalled = false;
  const spawnImpl = () => {
    spawnCalled = true;
    return fakeChild();
  };
  const execFileImpl = () => {
    execCalled = true;
    return '';
  };

  const graph = createGraph({ cwd, spawnImpl, execFileImpl });
  const result = await graph.ensure({ autobuild: false });

  assert.equal(result.action, 'skipped');
  assert.ok(result.reason);
  assert.equal(spawnCalled, false);
  assert.equal(execCalled, false);
  assert.equal(graph.status().watching, false);
});

test('ensure: no graph + autobuild:true → build (extract, cluster-only) then watch → built-then-watch', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));

  const execCalls: Array<{ file: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } }> = [];
  const execFileImpl = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    execCalls.push({ file, args, opts });
    return '';
  };
  const spawnCalls: Array<{ file: string; args: string[] }> = [];
  const spawnImpl = (file: string, args: string[]) => {
    spawnCalls.push({ file, args });
    return fakeChild();
  };

  const graph = createGraph({ cwd, spawnImpl, execFileImpl });
  const result = await graph.ensure({ autobuild: true });

  assert.deepEqual(result, { action: 'built-then-watch' });
  assert.equal(execCalls.length, 2);
  assert.equal(execCalls[0]!.file, 'graphify');
  assert.deepEqual(execCalls[0]!.args, ['extract', cwd, '--backend', 'openrouter']);
  assert.equal(execCalls[0]!.opts.env.GRAPHIFY_OPENROUTER_MODEL, 'deepseek/deepseek-v4-flash');
  assert.equal(execCalls[1]!.file, 'graphify');
  assert.deepEqual(execCalls[1]!.args, ['cluster-only', cwd, '--backend', 'openrouter']);
  assert.equal(execCalls[1]!.opts.env.GRAPHIFY_OPENROUTER_MODEL, 'deepseek/deepseek-v4-flash');

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0], { file: 'graphify', args: ['watch', cwd] });
});

test('stopWatch: kills the watcher and clears watching', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  mkdirSync(join(cwd, 'graphify-out'));
  writeFileSync(join(cwd, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [] }));

  let killed = false;
  const spawnImpl = () =>
    ({
      kill: () => {
        killed = true;
      },
      killed: false,
    }) as unknown as import('node:child_process').ChildProcess;

  const graph = createGraph({ cwd, spawnImpl });
  await graph.ensure();
  assert.equal(graph.status().watching, true);

  graph.stopWatch();
  assert.equal(killed, true);
  assert.equal(graph.status().watching, false);

  // guard: calling again with no watcher must not throw
  graph.stopWatch();
});
