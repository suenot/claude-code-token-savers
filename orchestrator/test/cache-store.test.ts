import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCache, hashKey, type CacheKey } from '../src/cache/store.ts';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'shuba-cache-'));
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

test('set then get returns the value', () => {
  const dir = tmpDir();
  const cache = createCache({ dir });
  const key: CacheKey = { namespace: 'ns', content: 'hello' };
  cache.set(key, 'world');
  assert.equal(cache.get(key), 'world');
});

test('get on a missing key returns null', () => {
  const cache = createCache({ dir: tmpDir() });
  assert.equal(cache.get({ namespace: 'ns', content: 'absent' }), null);
});

test('has reflects set', () => {
  const dir = tmpDir();
  const cache = createCache({ dir });
  const key: CacheKey = { namespace: 'ns', content: 'x' };
  assert.equal(cache.has(key), false);
  cache.set(key, 'v');
  assert.equal(cache.has(key), true);
});

test('same namespace+content, different algoVersion → independent slots', () => {
  const dir = tmpDir();
  const cache = createCache({ dir });
  const base = { namespace: 'ns', content: 'same' };
  cache.set({ ...base, algoVersion: 'v1' }, 'first');
  cache.set({ ...base, algoVersion: 'v2' }, 'second');
  assert.equal(cache.get({ ...base, algoVersion: 'v1' }), 'first');
  assert.equal(cache.get({ ...base, algoVersion: 'v2' }), 'second');
  assert.notEqual(
    hashKey({ ...base, algoVersion: 'v1' }),
    hashKey({ ...base, algoVersion: 'v2' }),
  );
});

test('no algoVersion: same content always maps to the same slot', () => {
  const a = hashKey({ namespace: 'ns', content: 'stable' });
  const b = hashKey({ namespace: 'ns', content: 'stable' });
  assert.equal(a, b);
  // ...and it differs from the algoVersion-folded slot for the same content.
  assert.notEqual(a, hashKey({ namespace: 'ns', content: 'stable', algoVersion: 'v1' }));
});

test('corrupt/partial file on disk → get returns null', () => {
  const dir = tmpDir();
  const cache = createCache({ dir });
  const key: CacheKey = { namespace: 'ns', content: 'corrupt' };
  const hash = hashKey(key);
  const shard = join(dir, hash.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, `${hash}.json`), '{ this is not valid json');
  assert.equal(cache.get(key), null);
});

test('atomic write leaves no .tmp file behind after set', () => {
  const dir = tmpDir();
  const cache = createCache({ dir });
  cache.set({ namespace: 'ns', content: 'clean' }, 'value');
  const leftover = allFiles(dir).filter((f) => f.includes('.tmp.'));
  assert.deepEqual(leftover, []);
});

test('ts field is deterministic via injected now', () => {
  const dir = tmpDir();
  const cache = createCache({ dir, now: () => 123456 });
  const key: CacheKey = { namespace: 'ns', content: 'timed' };
  cache.set(key, 'v');
  const [file] = allFiles(dir);
  const parsed = JSON.parse(readFileSync(file!, 'utf8'));
  assert.equal(parsed.ts, 123456);
  assert.equal(parsed.v, 'v');
});

test('entries are sharded into a 2-hex-char subdir', () => {
  const dir = tmpDir();
  const cache = createCache({ dir });
  const key: CacheKey = { namespace: 'ns', content: 'shardme' };
  cache.set(key, 'v');
  const hash = hashKey(key);
  assert.ok(existsSync(join(dir, hash.slice(0, 2), `${hash}.json`)));
});
