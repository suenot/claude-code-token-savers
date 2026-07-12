import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../src/graph/load.ts';
import { queryGraph, orientation, inferContextFilters, isTraceQuestion } from '../src/graph/query.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'graph.json'), 'utf8'));
const g = loadGraph(fixture);

test("auto mode picks DFS for a trace/path question and BFS for 'how does X work'", () => {
  const trace = queryGraph(g, 'trace path from login to logEvent', { mode: 'auto' });
  assert.match(trace, /Traversal: DFS/);
  const explain = queryGraph(g, 'how does login work', { mode: 'auto' });
  assert.match(explain, /Traversal: BFS/);
});

test('isTraceQuestion distinguishes trace from explain questions', () => {
  assert.equal(isTraceQuestion('trace path from a to b'), true);
  assert.equal(isTraceQuestion('why does login fail'), true);
  assert.equal(isTraceQuestion('how does login work'), false);
});

test('queryGraph resolves seeds and renders a budgeted subgraph', () => {
  const out = queryGraph(g, 'login');
  assert.match(out, /Start: \[login\]/);
  assert.match(out, /NODE login/);
});

test('inferContextFilters maps question verbs to edge-context filters', () => {
  assert.deepEqual(inferContextFilters('what does login call'), ['call']);
  assert.deepEqual(inferContextFilters('what does login return'), ['return_type']);
  assert.deepEqual(inferContextFilters('what does app import'), ['import']);
});

test('queryGraph applies an inferred context filter in the header', () => {
  const out = queryGraph(g, 'what does login call', { mode: 'bfs' });
  assert.match(out, /Context: call \(heuristic\)/);
});

test('queryGraph returns a clear message when nothing matches', () => {
  assert.equal(queryGraph(g, 'zzzznotacode'), 'No matching nodes found.');
});

test('orientation summarizes god nodes with degrees', () => {
  const out = orientation(g);
  assert.match(out, /Graph: 17 nodes, 24 edges/);
  assert.match(out, /God nodes/);
  assert.match(out, /AuthService — 6 edges/);
});
