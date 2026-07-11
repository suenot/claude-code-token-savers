import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraph } from '../src/control/graph.ts';

test('status: no graph → built false', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  assert.deepEqual(createGraph({ cwd }).status().built, false);
});

test('status: graph present → built true, node_count from nodes[]', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  mkdirSync(join(cwd, 'graphify-out'));
  writeFileSync(join(cwd, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{}, {}, {}] }));
  const s = createGraph({ cwd }).status();
  assert.equal(s.built, true);
  assert.equal(s.node_count, 3);
  assert.equal(typeof s.last_built, 'number');
});
