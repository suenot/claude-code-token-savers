import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraph } from '../src/control/graph.ts';

test('e2e: status reports a seeded graph.json; query answers natively without the CLI', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-e2e-'));
  mkdirSync(join(cwd, 'graphify-out'));
  writeFileSync(
    join(cwd, 'graphify-out', 'graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'a', label: 'SomeNode', type: 'class' },
        { id: 'b', label: 'Other', type: 'function' },
      ],
      edges: [{ source: 'a', target: 'b', type: 'call' }],
    }),
  );

  const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
  const execFileImpl = (file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts });
    return 'CANNED EXPLAIN';
  };

  const graph = createGraph({ cwd, execFileImpl });

  const status = graph.status();
  assert.equal(status.built, true);
  assert.equal(status.node_count, 2);

  // graph.json exists → the native engine answers in-process, zero tokens, and
  // the graphify CLI is never spawned.
  const result = graph.query('SomeNode');
  assert.equal(result.ok, true);
  assert.match(result.result, /SomeNode/);
  assert.equal(calls.length, 0);
});
