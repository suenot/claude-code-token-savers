import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { REGISTRY } from '../src/registry.ts';
import type { Config } from '../src/types.ts';

test('a config with a graph block round-trips through loadConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-graph-config-'));
  const path = join(dir, 'chain.json');
  try {
    const written: Config = {
      terminal: 'anthropic',
      compressors: [],
      graph: { model: 'deepseek/deepseek-v4-flash', autobuild: true },
    };
    writeFileSync(path, JSON.stringify(written, null, 2));

    const { config, created } = loadConfig(path);
    assert.equal(created, false);
    assert.equal(config.graph?.autobuild, true);
    assert.deepEqual(config.graph, written.graph);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry control.build env includes GRAPH_JSON', () => {
  const result = REGISTRY.control!.build({
    port: 47830,
    config: { terminal: 'anthropic', compressors: [], graph: { model: 'm', autobuild: true } },
  });
  assert.ok(result.env.GRAPH_JSON);
  const parsed = JSON.parse(result.env.GRAPH_JSON);
  assert.deepEqual(parsed, { model: 'm', autobuild: true });
});
