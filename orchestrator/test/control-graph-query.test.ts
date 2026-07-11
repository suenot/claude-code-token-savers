import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGraph } from '../src/control/graph.ts';

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
