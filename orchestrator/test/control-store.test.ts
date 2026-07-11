import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createStore } from '../src/control/store.ts';

function tmp() { return mkdtempSync(join(tmpdir(), 'shuba-store-')); }

test('create persists a queued record to <id>.json and returns it', () => {
  const dir = tmp();
  let t = 1000;
  const s = createStore({ dir, now: () => t });
  const rec = s.create({ id: '', task: 'do x', harness: 'opencode', model: null, cwd: '/repo', isolation: 'none' } as any);
  assert.equal(rec.status, 'queued');
  assert.ok(rec.id.startsWith('job_'));
  assert.deepEqual(s.get(rec.id), rec);
  const onDisk = JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf8'));
  assert.equal(onDisk.status, 'queued');
});

test('update patches, re-persists, and list reflects it', () => {
  const dir = tmp();
  const s = createStore({ dir, now: () => 5 });
  const rec = s.create({ id: '', task: 't', harness: 'gemini', model: 'gemini-flash', cwd: '/r', isolation: 'none' } as any);
  const upd = s.update(rec.id, { status: 'running', startedAt: 5 });
  assert.equal(upd.status, 'running');
  assert.equal(s.list().length, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, `${rec.id}.json`), 'utf8')).status, 'running');
});

test('appendLog + readLog round-trip', () => {
  const dir = tmp();
  const s = createStore({ dir, now: () => 5 });
  const rec = s.create({ id: '', task: 't', harness: 'qwen', model: null, cwd: '/r', isolation: 'none' } as any);
  s.appendLog(rec.id, 'line1\n'); s.appendLog(rec.id, 'line2\n');
  assert.equal(s.readLog(rec.id), 'line1\nline2\n');
  assert.ok(existsSync(join(dir, `${rec.id}.log`)));
});

test('ids are unique across rapid create at same timestamp', () => {
  const s = createStore({ dir: tmp(), now: () => 42 });
  const a = s.create({ id: '', task: 'a', harness: 'x', model: null, cwd: '/', isolation: 'none' } as any);
  const b = s.create({ id: '', task: 'b', harness: 'x', model: null, cwd: '/', isolation: 'none' } as any);
  assert.notEqual(a.id, b.id);
});
