import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isStageEnabled, persistToggle, readToggles, runtimePath, setToggle } from '../src/control/toggles.ts';

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-toggles-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('runtimePath honors SHUBA_RUNTIME override', () => {
  const prev = process.env.SHUBA_RUNTIME;
  try {
    process.env.SHUBA_RUNTIME = '/tmp/custom-runtime.json';
    assert.equal(runtimePath(), '/tmp/custom-runtime.json');
    delete process.env.SHUBA_RUNTIME;
    assert.ok(runtimePath().endsWith('.shuba/runtime.json'));
  } finally {
    if (prev === undefined) delete process.env.SHUBA_RUNTIME;
    else process.env.SHUBA_RUNTIME = prev;
  }
});

test('with no file present, isStageEnabled defaults to true and readToggles is empty', () => {
  withTempDir((dir) => {
    const path = join(dir, 'runtime.json');
    assert.deepEqual(readToggles(path), {});
    assert.equal(isStageEnabled('rate-limiter', path), true);
  });
});

test('setToggle writes runtime.json and is reflected by readToggles/isStageEnabled', () => {
  withTempDir((dir) => {
    const path = join(dir, 'runtime.json');
    const updated = setToggle('rate-limiter', false, path);
    assert.equal(updated['rate-limiter'], false);
    assert.equal(readToggles(path)['rate-limiter'], false);
    assert.equal(isStageEnabled('rate-limiter', path), false);
  });
});

test('malformed runtime.json never throws, treated as enabled', () => {
  withTempDir((dir) => {
    const path = join(dir, 'runtime.json');
    writeFileSync(path, '{ not valid json');
    assert.deepEqual(readToggles(path), {});
    assert.equal(isStageEnabled('rate-limiter', path), true);
  });
});

test('disabling one stage leaves unrelated stages enabled', () => {
  withTempDir((dir) => {
    const path = join(dir, 'runtime.json');
    setToggle('rate-limiter', false, path);
    assert.equal(isStageEnabled('compact-router', path), true);
    assert.equal(isStageEnabled('context-watchdog', path), true);
  });
});

test('isStageEnabled picks up a changed file even within the cache window (mtime changed)', () => {
  withTempDir((dir) => {
    const path = join(dir, 'runtime.json');
    setToggle('rate-limiter', false, path);
    assert.equal(isStageEnabled('rate-limiter', path), false);
    setToggle('rate-limiter', true, path);
    assert.equal(isStageEnabled('rate-limiter', path), true);
  });
});

test('persistToggle merges toggles into an existing chain.json without clobbering other keys', () => {
  withTempDir((dir) => {
    const chainPath = join(dir, 'chain.json');
    writeFileSync(chainPath, JSON.stringify({ terminal: 'anthropic', compressors: ['headroom'] }, null, 2));
    persistToggle('rate-limiter', false, chainPath);
    const written = JSON.parse(readFileSync(chainPath, 'utf8'));
    assert.equal(written.terminal, 'anthropic');
    assert.deepEqual(written.compressors, ['headroom']);
    assert.deepEqual(written.toggles, { 'rate-limiter': false });
    persistToggle('compact-router', true, chainPath);
    const written2 = JSON.parse(readFileSync(chainPath, 'utf8'));
    assert.deepEqual(written2.toggles, { 'rate-limiter': false, 'compact-router': true });
  });
});

test('persistToggle creates chain.json when absent', () => {
  withTempDir((dir) => {
    const chainPath = join(dir, 'nested', 'chain.json');
    persistToggle('headroom', false, chainPath);
    const written = JSON.parse(readFileSync(chainPath, 'utf8'));
    assert.deepEqual(written.toggles, { headroom: false });
  });
});
