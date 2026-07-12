import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../src/graph/load.ts';
import { godNodes } from '../src/graph/god.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'graph.json'), 'utf8'));
const g = loadGraph(fixture);

test('godNodes ranks the most-connected real entities by degree', () => {
  const gods = godNodes(g);
  const labels = gods.map((n) => n.label);
  // The two degree-6 nodes lead the ranking.
  assert.deepEqual(new Set(labels.slice(0, 2)), new Set(['AuthService', 'logEvent']));
  const degrees = gods.map((n) => g.degree.get(n.id) ?? 0);
  for (let i = 1; i < degrees.length; i++) {
    assert.ok(degrees[i - 1]! >= degrees[i]!);
  }
});

test('godNodes excludes file, concept, and json-key nodes', () => {
  const labels = godNodes(g).map((n) => n.label);
  assert.ok(!labels.includes('app.ts')); // file
  assert.ok(!labels.includes('auth.ts')); // file
  assert.ok(!labels.includes('authentication')); // concept
  assert.ok(!labels.includes('security')); // concept
  assert.ok(!labels.includes('dependencies')); // json-key noise
});

test('godNodes respects the top-n limit', () => {
  assert.equal(godNodes(g, 3).length, 3);
});

test('godNodes excludes builtin/mock noise labels and file heuristics', () => {
  const noisy = loadGraph({
    nodes: [
      { id: 'RealService', label: 'RealService', source_file: 'svc.ts' },
      { id: 'str', label: 'str', source_file: 'svc.ts' },
      { id: 'helper.py', label: 'helper.py', source_file: 'helper.py' },
      { id: 'concept', label: 'concept', source_file: '' },
    ],
    edges: [
      { source: 'RealService', target: 'str', type: 'call' },
      { source: 'RealService', target: 'helper.py', type: 'call' },
      { source: 'RealService', target: 'concept', type: 'call' },
    ],
  });
  assert.deepEqual(godNodes(noisy).map((n) => n.label), ['RealService']);
});
