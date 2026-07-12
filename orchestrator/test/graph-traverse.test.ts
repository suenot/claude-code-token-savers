import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../src/graph/load.ts';
import { bfs, dfs, computeHubThreshold } from '../src/graph/traverse.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'graph.json'), 'utf8'));
const g = loadGraph(fixture);

test('bfs expands broadly from a seed', () => {
  const { nodes } = bfs(g, ['login'], 1);
  // Depth-1 neighbours of login (undirected): callees + its container.
  assert.ok(nodes.has('hashPassword'));
  assert.ok(nodes.has('validateToken'));
  assert.ok(nodes.has('logEvent'));
  assert.ok(nodes.has('AuthService'));
});

test('edgeFilter restricts traversal to matching edge types', () => {
  const { nodes } = bfs(g, ['login'], 1, ['call']);
  assert.ok(nodes.has('logEvent')); // reached via a call edge
  assert.ok(!nodes.has('AuthService')); // only a `contains` edge → excluded
  assert.ok(!nodes.has('User')); // only a `return_type` edge → excluded
});

// A star graph: hub H links to 4 leaves; seed S links to H.
const star = loadGraph({
  nodes: ['S', 'H', 'L1', 'L2', 'L3', 'L4'].map((id) => ({ id, label: id })),
  edges: [
    { source: 'S', target: 'H', type: 'call' },
    { source: 'H', target: 'L1', type: 'call' },
    { source: 'H', target: 'L2', type: 'call' },
    { source: 'H', target: 'L3', type: 'call' },
    { source: 'H', target: 'L4', type: 'call' },
  ],
});

test('hub-gating visits a hub but does not expand through it', () => {
  const { nodes } = bfs(star, ['S'], 3, undefined, { hubThreshold: 3 });
  assert.ok(nodes.has('H')); // hub is visited
  assert.ok(!nodes.has('L1')); // but not expanded through
  assert.equal(nodes.size, 2);
});

test('without gating the hub is fully expanded', () => {
  const { nodes } = bfs(star, ['S'], 3, undefined, { hubThreshold: 100 });
  assert.ok(nodes.has('L1'));
  assert.ok(nodes.has('L4'));
});

test('dfs also honours hub-gating', () => {
  const { nodes } = dfs(star, ['S'], 3, undefined, { hubThreshold: 3 });
  assert.ok(nodes.has('H'));
  assert.ok(!nodes.has('L2'));
});

test('computeHubThreshold floors at 50', () => {
  assert.equal(computeHubThreshold(g), 50);
});
