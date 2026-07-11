import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { plan } from '../src/planner.ts';
import type { Config } from '../src/types.ts';

test('a config with a delegate block round-trips through loadConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-control-config-'));
  const path = join(dir, 'chain.json');
  try {
    const written: Config = {
      terminal: 'anthropic',
      compressors: ['headroom'],
      delegate: {
        default: { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' },
        concurrency: 2,
        isolation: 'worktree',
        policy: [{ when: 'refactor', harness: 'claude', model: 'sonnet' }],
      },
    };
    writeFileSync(path, JSON.stringify(written, null, 2));

    const { config, created } = loadConfig(path);
    assert.equal(created, false);
    assert.deepEqual(config.delegate, written.delegate);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan() surfaces control as a sidecar by default given a delegate config', () => {
  const config: Config = {
    terminal: 'anthropic',
    compressors: ['headroom'],
    delegate: { default: { harness: 'opencode', model: 'deepseek/deepseek-v4-flash' } },
  };
  const r = plan(config);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const control = r.sidecars.find((s) => s.id === 'control');
  assert.ok(control);
  const parsed = JSON.parse(control!.spawn.env.DELEGATE_JSON);
  assert.deepEqual(parsed, config.delegate);
});
