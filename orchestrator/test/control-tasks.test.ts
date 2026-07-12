import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskManager } from '../src/control/tasks.ts';

function withTasksDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-tasks-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('createTask assigns sequential T-NNN ids and defaults status to pending', () => {
  withTasksDir((dir) => {
    const tasks = createTaskManager(dir);
    const t1 = tasks.createTask({ priority: 'high', title: 'first', description: 'desc' });
    const t2 = tasks.createTask({ priority: 'low', title: 'second', description: 'desc' });
    assert.equal(t1.id, 'T-001');
    assert.equal(t2.id, 'T-002');
    assert.equal(t1.status, 'pending');
  });
});

test('createTask round-trips through the frontmatter file (title, description, contextFiles)', () => {
  withTasksDir((dir) => {
    const tasks = createTaskManager(dir);
    tasks.createTask({
      priority: 'critical',
      title: 'fix the thing',
      description: 'multi\nline\nbody',
      contextFiles: ['a.ts', 'b.ts'],
      source: 'manual',
    });
    const got = tasks.getTask('T-001');
    assert.equal(got?.title, 'fix the thing');
    assert.equal(got?.description, 'multi\nline\nbody');
    assert.deepEqual(got?.contextFiles, ['a.ts', 'b.ts']);
    assert.equal(got?.source, 'manual');
  });
});

test('listTasks filters by status', () => {
  withTasksDir((dir) => {
    const tasks = createTaskManager(dir);
    const t1 = tasks.createTask({ priority: 'high', title: 'a', description: 'd' });
    tasks.createTask({ priority: 'low', title: 'b', description: 'd' });
    tasks.updateStatus(t1.id, 'completed');
    assert.deepEqual(tasks.listTasks('pending').map((t) => t.title), ['b']);
    assert.deepEqual(tasks.listTasks('completed').map((t) => t.title), ['a']);
    assert.equal(tasks.listTasks().length, 2);
  });
});

test('updateStatus sets completedAt on completed/dismissed and returns false for unknown id', () => {
  withTasksDir((dir) => {
    const tasks = createTaskManager(dir);
    const t = tasks.createTask({ priority: 'medium', title: 'x', description: 'd' });
    assert.equal(tasks.updateStatus(t.id, 'dismissed'), true);
    assert.ok(tasks.getTask(t.id)?.completedAt);
    assert.equal(tasks.updateStatus('T-999', 'completed'), false);
  });
});

test('getPendingSummary sorts by priority and caps at maxItems, empty queue returns empty string', () => {
  withTasksDir((dir) => {
    const tasks = createTaskManager(dir);
    assert.equal(tasks.getPendingSummary(), '');
    tasks.createTask({ priority: 'low', title: 'low prio', description: 'd' });
    tasks.createTask({ priority: 'critical', title: 'urgent', description: 'd', contextFiles: ['x.ts'] });
    tasks.createTask({ priority: 'medium', title: 'mid', description: 'd' });
    const summary = tasks.getPendingSummary(2);
    assert.match(summary, /Pending shuba tasks \(3 total\)/);
    const lines = summary.split('\n');
    assert.ok(lines[1]!.includes('urgent'));
    assert.ok(lines.some((l) => l.includes('x.ts')));
    assert.ok(!summary.includes('low prio'));
  });
});

test('listTasks skips a corrupt task file instead of throwing', () => {
  withTasksDir((dir) => {
    const tasks = createTaskManager(dir);
    tasks.createTask({ priority: 'high', title: 'ok', description: 'd' });
    // Simulate corruption directly via fs, bypassing the manager.
    writeFileSync(join(dir, 'T-999.md'), 'not frontmatter at all');
    const listed = tasks.listTasks();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.title, 'ok');
  });
});
