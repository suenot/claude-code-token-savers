import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilityStore, type CapabilityEntry } from '../src/capabilities/store.ts';

function withStore(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'shuba-cap-store-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function entry(id: string, over: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    id,
    type: 'skill',
    name: id,
    description: '',
    sourcePath: '/x',
    enabled: true,
    importedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('empty store reads as [] and get/has are safe', () => {
  withStore((root) => {
    const store = createCapabilityStore({ root });
    assert.deepEqual(store.read(), []);
    assert.equal(store.get('nope'), undefined);
    assert.equal(store.has('nope'), false);
  });
});

test('upsert inserts then updates in place', () => {
  withStore((root) => {
    const store = createCapabilityStore({ root });
    store.upsert(entry('skill:a'));
    store.upsert(entry('skill:b'));
    store.upsert(entry('skill:a', { description: 'updated' }));
    assert.equal(store.read().length, 2);
    assert.equal(store.get('skill:a')?.description, 'updated');
  });
});

test('remove drops an entry and reports whether it existed', () => {
  withStore((root) => {
    const store = createCapabilityStore({ root });
    store.upsert(entry('skill:a'));
    assert.equal(store.remove('skill:a'), true);
    assert.equal(store.remove('skill:a'), false);
    assert.deepEqual(store.read(), []);
  });
});

test('setEnabled toggles the flag, false for unknown id', () => {
  withStore((root) => {
    const store = createCapabilityStore({ root });
    store.upsert(entry('skill:a'));
    assert.equal(store.setEnabled('skill:a', false), true);
    assert.equal(store.get('skill:a')?.enabled, false);
    assert.equal(store.setEnabled('nope', true), false);
  });
});

test('reversal metadata round-trips and clears', () => {
  withStore((root) => {
    const store = createCapabilityStore({ root });
    store.writeReversal('skill:a', { backupPath: '/b', restorePath: '/r' });
    assert.deepEqual(store.readReversal('skill:a'), { backupPath: '/b', restorePath: '/r' });
    store.clearReversal('skill:a');
    assert.equal(store.readReversal('skill:a'), undefined);
  });
});

test('read never throws on a corrupt manifest.json', () => {
  withStore((root) => {
    writeFileSync(join(root, 'manifest.json'), 'not json{');
    const store = createCapabilityStore({ root });
    assert.deepEqual(store.read(), []);
  });
});
