import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraph } from '../src/control/graph.ts';

test('e2e: status + query wrapper wiring over a seeded graph.json with a stubbed graphify CLI', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-e2e-'));
  mkdirSync(join(cwd, 'graphify-out'));
  writeFileSync(join(cwd, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{}, {}] }));

  const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
  const execFileImpl = (file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts });
    return 'CANNED EXPLAIN';
  };

  const graph = createGraph({ cwd, execFileImpl });

  const status = graph.status();
  assert.equal(status.built, true);
  assert.equal(status.node_count, 2);

  const result = graph.query('SomeNode');
  assert.deepEqual(result, { ok: true, result: 'CANNED EXPLAIN' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, 'graphify');
  assert.deepEqual(calls[0]!.args, [
    'explain',
    'SomeNode',
    '--graph',
    join(cwd, 'graphify-out', 'graph.json'),
  ]);
});
