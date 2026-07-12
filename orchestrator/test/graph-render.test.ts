import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../src/graph/load.ts';
import { renderSubgraph } from '../src/graph/render.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'graph.json'), 'utf8'));
const g = loadGraph(fixture);
const allNodes = new Set(g.nodes.keys());

test('renderSubgraph puts seeds first, then nodes by degree descending', () => {
  const out = renderSubgraph(g, allNodes, ['login'], 5000);
  const nodeLines = out.split('\n').filter((l) => l.startsWith('NODE '));
  assert.match(nodeLines[0]!, /^NODE login\b/); // seed first
  const restDegrees = nodeLines
    .slice(1)
    .map((l) => l.replace(/^NODE /, '').split(' ')[0]!)
    .map((label) => g.degree.get(label) ?? 0);
  for (let i = 1; i < restDegrees.length; i++) {
    assert.ok(restDegrees[i - 1]! >= restDegrees[i]!, 'degree must be non-increasing');
  }
});

test('renderSubgraph emits NODE and EDGE lines', () => {
  const out = renderSubgraph(g, allNodes, ['login'], 5000);
  assert.match(out, /NODE login \[type=function/);
  assert.match(out, /EDGE login --calls .*--> logEvent/);
});

test('renderSubgraph stays near budget and appends a truncation footer', () => {
  const budget = 15;
  const out = renderSubgraph(g, allNodes, ['login'], budget);
  assert.match(out, /more nodes cut by ~15-token budget/);
  assert.match(out, /Narrow with a more specific term or query a named node/);
  // Body is cut at budget*3 chars; only the footer may push slightly past it.
  const footerLen = 120;
  assert.ok(out.length <= budget * 3 + footerLen);
});

test('renderSubgraph without truncation has no footer', () => {
  const out = renderSubgraph(g, new Set(['login', 'logEvent']), ['login'], 5000);
  assert.doesNotMatch(out, /more nodes cut/);
});
