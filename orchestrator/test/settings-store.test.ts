import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, writeSettings, sanitizeSettings } from '../src/control/settings-store.ts';

function tmpChain(seed: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-settings-'));
  const p = join(dir, 'chain.json');
  writeFileSync(p, JSON.stringify(seed));
  return p;
}

test('sanitizeSettings whitelists fields and coerces types', () => {
  const s: any = sanitizeSettings({
    contextWatchdog: { thresholdTokens: 300000, tailTurns: 6, bogus: 'x' },
    rateLimiter: { rps: 2, burst: '5' /* wrong type -> dropped */ },
    imageShrink: { scale: '1/2', minBytes: 4096 },
    modelRouter: { routes: { image: { mode: 'ocr', dropImage: true }, junkCat: { model: 'x' } } },
    delegate: { default: { harness: 'opencode', model: 'deepseek/x' }, concurrency: 3 },
    unknownSection: { a: 1 },
  });
  assert.equal(s.contextWatchdog.thresholdTokens, 300000);
  assert.equal(s.contextWatchdog.bogus, undefined);
  assert.equal(s.rateLimiter.rps, 2);
  assert.equal(s.rateLimiter.burst, undefined);
  assert.equal(s.imageShrink.scale, '1/2');
  assert.equal(s.modelRouter.routes.image.mode, 'ocr');
  assert.equal(s.modelRouter.routes.junkCat, undefined);
  assert.equal(s.delegate.default.harness, 'opencode');
  assert.equal(s.unknownSection, undefined);
});

test('writeSettings merges into chain.json, preserving unrelated keys', () => {
  const p = tmpChain({ terminal: 'anthropic', compressors: ['headroom', 'context-watchdog'], toggles: { dedup: false } });
  writeSettings({ contextWatchdog: { thresholdTokens: 300000 }, compactRouter: { model: 'a8e/a8e-1.0-pro' } }, p);
  const chain = JSON.parse(readFileSync(p, 'utf8'));
  // unrelated keys untouched
  assert.deepEqual(chain.compressors, ['headroom', 'context-watchdog']);
  assert.deepEqual(chain.toggles, { dedup: false });
  // new settings written
  assert.equal(chain.contextWatchdog.thresholdTokens, 300000);
  assert.equal(chain.compactRouter.model, 'a8e/a8e-1.0-pro');
  // readSettings returns them back
  const s: any = readSettings(p);
  assert.equal(s.contextWatchdog.thresholdTokens, 300000);
});

test('readSettings on a chain without model config returns empty', () => {
  const p = tmpChain({ terminal: 'anthropic', compressors: [] });
  assert.deepEqual(readSettings(p), {});
});
