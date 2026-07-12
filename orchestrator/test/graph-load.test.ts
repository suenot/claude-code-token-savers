import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph, edgeType } from '../src/graph/load.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'graph.json'), 'utf8'));

test('loadGraph indexes nodes, undirected adjacency, and total degree', () => {
  const g = loadGraph(fixture);
  assert.equal(g.nodes.size, 17);
  // logEvent is called by 6 functions → total degree 6, top hub.
  assert.equal(g.degree.get('logEvent'), 6);
  // Adjacency is undirected: the login→logEvent edge appears on both endpoints.
  assert.ok(g.adjacency.get('login')!.some((e) => e.to === 'logEvent'));
  assert.ok(g.adjacency.get('logEvent')!.some((e) => e.to === 'login'));
});

test('loadGraph tolerates `entities` + `from`/`to` field aliases', () => {
  const g = loadGraph({
    entities: [
      { id: 'a', label: 'Alpha', type: 'class' },
      { id: 'b', label: 'Beta', type: 'function' },
    ],
    edges: [{ from: 'a', to: 'b', context: 'call' }],
  });
  assert.equal(g.nodes.size, 2);
  assert.equal(g.degree.get('a'), 1);
  assert.equal(g.degree.get('b'), 1);
  assert.equal(edgeType(g.adjacency.get('a')![0]!.edge), 'call');
});

test('loadGraph reads edges under `links` and materializes stub endpoints', () => {
  const g = loadGraph({ nodes: [{ id: 'x', label: 'X' }], links: [{ source: 'x', target: 'y' }] });
  assert.equal(g.nodes.size, 2);
  assert.equal(g.nodes.get('y')!.label, 'y');
});

test('loadGraph on empty/garbage input yields an empty index', () => {
  const g = loadGraph(null);
  assert.equal(g.nodes.size, 0);
  assert.equal(g.degree.size, 0);
});
