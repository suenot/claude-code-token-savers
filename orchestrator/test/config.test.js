import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, configPath, loadConfig } from '../src/config.js';

test('configPath is <home>/.shuba/chain.json', () => {
  assert.equal(configPath('/Users/x'), '/Users/x/.shuba/chain.json');
});

test('loadConfig writes default when file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-'));
  try {
    const p = join(dir, '.shuba', 'chain.json');
    const { config, created } = loadConfig(p);
    assert.equal(created, true);
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig reads an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-'));
  try {
    const p = join(dir, 'chain.json');
    const custom = { terminal: 'codex', compressors: ['headroom'], ports: {} };
    writeFileSync(p, JSON.stringify(custom));
    const { config, created } = loadConfig(p);
    assert.equal(created, false);
    assert.deepEqual(config, custom);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
