import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, finalizeWorktree } from '../src/control/worktree.ts';

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'wt-'));
  execSync('git init -q && git commit -q --allow-empty -m init', { cwd: d, shell: '/bin/bash' });
  return d;
}

test('createWorktree makes a path; unchanged → finalize removes it', () => {
  const d = repo();
  const { path } = createWorktree(d, 'job_1');
  assert.ok(existsSync(path));
  const { removed } = finalizeWorktree(d, path);
  assert.equal(removed, true);
  assert.equal(existsSync(path), false);
});

test('changed worktree → diff captured, not removed', () => {
  const d = repo();
  const { path } = createWorktree(d, 'job_2');
  writeFileSync(join(path, 'new.txt'), 'x');
  execSync('git add -A', { cwd: path, shell: '/bin/bash' });
  const { diff, removed, files } = finalizeWorktree(d, path);
  assert.match(diff, /new\.txt/);
  assert.equal(removed, false);
  assert.deepEqual(files, ['new.txt']);
});
