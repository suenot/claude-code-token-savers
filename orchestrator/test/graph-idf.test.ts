import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph } from '../src/graph/load.ts';
import { queryTerms, isSearchable, computeIdf, normTerms, pickSeeds } from '../src/graph/idf.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'graph.json'), 'utf8'));
const g = loadGraph(fixture);

function seeds(question: string): string[] {
  const terms = queryTerms(question);
  const idf = computeIdf(g, normTerms(terms));
  return pickSeeds(g, terms, idf);
}

test('queryTerms lowercases, splits on non-alphanumeric, drops short/empty tokens', () => {
  assert.deepEqual(queryTerms('How does login() work?'), ['how', 'does', 'login', 'work']);
  assert.equal(isSearchable('is'), false);
  assert.equal(isSearchable('log'), true);
  assert.equal(isSearchable('v2'), true);
});

test('computeIdf weights rare identifiers above common tokens', () => {
  const idf = computeIdf(g, ['hashpassword', 'log']);
  // 'log' appears in login/logout/logEvent (df=3); 'hashpassword' in one node.
  assert.ok(idf.get('hashpassword')! > idf.get('log')!);
});

test('pickSeeds returns the rare/specific identifier over common noise', () => {
  const s = seeds('validateToken user');
  assert.equal(s[0], 'validateToken');
});

test('pickSeeds gap cutoff drops low-scoring noise terms', () => {
  // 'hashPassword' scores ~2250 (exact); the 'log' prefix matches score ~166,
  // well below top*0.2, so only the dominant identifier is seeded.
  assert.deepEqual(seeds('hashPassword log'), ['hashPassword']);
});

test('pickSeeds returns nothing when no term matches', () => {
  assert.deepEqual(seeds('nonexistentsymbol'), []);
});
