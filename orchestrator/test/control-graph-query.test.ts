import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraph } from '../src/control/graph.ts';

// Write a minimal graphify-out/graph.json under a fresh cwd and return the cwd.
function cwdWithGraph(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  mkdirSync(join(cwd, 'graphify-out'), { recursive: true });
  const graph = {
    nodes: [
      { id: 'n1', label: 'AuthService', type: 'class' },
      { id: 'n2', label: 'Database', type: 'class' },
      { id: 'n3', label: 'login', type: 'function' },
    ],
    edges: [
      { source: 'n1', target: 'n3', type: 'contains' },
      { source: 'n3', target: 'n2', type: 'call' },
    ],
  };
  writeFileSync(join(cwd, 'graphify-out', 'graph.json'), JSON.stringify(graph));
  return cwd;
}

test('query: native engine answers from an existing graph.json without invoking the CLI', () => {
  const cwd = cwdWithGraph();
  const calls: unknown[] = [];
  const execFileImpl = (file: string, args: string[]) => {
    calls.push({ file, args });
    return 'should-not-be-reached';
  };

  const result = createGraph({ cwd, execFileImpl }).query('AuthService');

  assert.equal(calls.length, 0); // CLI never touched — zero tokens, no subprocess
  assert.equal(result.ok, true);
  assert.match(result.result, /AuthService/);
});

test('query: corrupt graph.json falls back to the CLI', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  mkdirSync(join(cwd, 'graphify-out'), { recursive: true });
  writeFileSync(join(cwd, 'graphify-out', 'graph.json'), 'not json{');
  const calls: unknown[] = [];
  const execFileImpl = (file: string, args: string[]) => {
    calls.push({ file, args });
    return 'canned-cli-output';
  };

  const result = createGraph({ cwd, execFileImpl }).query('foo');

  assert.equal(calls.length, 1); // fell through to CLI
  assert.deepEqual(result, { ok: true, result: 'canned-cli-output' });
});

test('query: explain form invokes graphify explain with --graph', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
  const execFileImpl = (file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts });
    return 'canned-explain-output';
  };

  const result = createGraph({ cwd, execFileImpl }).query('foo');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, 'graphify');
  assert.deepEqual(calls[0]!.args, [
    'explain',
    'foo',
    '--graph',
    join(cwd, 'graphify-out', 'graph.json'),
  ]);
  assert.deepEqual(result, { ok: true, result: 'canned-explain-output' });
});

test('query: "A -> B" form invokes graphify path A B with --graph', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
  const execFileImpl = (file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts });
    return 'canned-path-output';
  };

  const result = createGraph({ cwd, execFileImpl }).query('A -> B');

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, 'graphify');
  assert.deepEqual(calls[0]!.args, [
    'path',
    'A',
    'B',
    '--graph',
    join(cwd, 'graphify-out', 'graph.json'),
  ]);
  assert.deepEqual(result, { ok: true, result: 'canned-path-output' });
});

test('query: throwing execFileImpl → {ok:false, result:<message>} (no throw)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  const execFileImpl = () => {
    throw new Error('boom');
  };

  const result = createGraph({ cwd, execFileImpl }).query('foo');

  assert.equal(result.ok, false);
  assert.match(result.result, /boom/);
});

test('query: leading-dash query (flag-like) is rejected before reaching execFile (argv injection guard)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  const calls: Array<{ file: string; args: string[]; opts: unknown }> = [];
  const execFileImpl = (file: string, args: string[], opts: unknown) => {
    calls.push({ file, args, opts });
    return 'should-not-be-reached';
  };

  const result = createGraph({ cwd, execFileImpl }).query('--graph');

  assert.equal(calls.length, 0);
  assert.deepEqual(result, { ok: false, result: 'invalid query (leading dash)' });
});

test('query: leading-dash node in "A -> B" path form is rejected', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'g-'));
  const execFileImpl = () => 'should-not-be-reached';

  const result = createGraph({ cwd, execFileImpl }).query('--backend -> B');

  assert.deepEqual(result, { ok: false, result: 'invalid query (leading dash)' });
});
