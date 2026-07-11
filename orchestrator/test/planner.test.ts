import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../src/planner.ts';

test('compressors on anthropic terminal: pxpipe -> headroom -> api.anthropic.com', () => {
  const r = plan({ terminal: 'anthropic', compressors: ['pxpipe', 'headroom'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.chain.map((s) => s.id), ['pxpipe', 'headroom']);
  assert.equal(r.head.baseUrl, 'http://127.0.0.1:47821');
  assert.equal(r.head.requiresToken, false);
  // pxpipe forwards to headroom; headroom forwards to real anthropic
  assert.equal(r.chain[0].spawn.env.ANTHROPIC_UPSTREAM, 'http://127.0.0.1:8787');
  assert.equal(r.chain[1].spawn.env.ANTHROPIC_TARGET_API_URL, 'https://api.anthropic.com');
});

test('route to codex with headroom: headroom -> router(codex); pxpipe excluded', () => {
  const r = plan({ terminal: 'codex', compressors: ['headroom'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.chain.map((s) => s.id), ['headroom', 'router']);
  // head points at headroom; headroom forwards to router WITH the router path suffix
  assert.equal(r.head.baseUrl, 'http://127.0.0.1:8787');
  assert.equal(r.head.requiresToken, true);
  assert.equal(
    r.chain[0].spawn.env.ANTHROPIC_TARGET_API_URL,
    'http://127.0.0.1:8080/api/latest/anthropic',
  );
  assert.equal(r.chain[1].spawn.env.UPSTREAM_PROVIDER, 'codex');
});

test('route only: head is router with path suffix and requiresToken', () => {
  const r = plan({ terminal: 'codex', compressors: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.chain.map((s) => s.id), ['router']);
  assert.equal(r.head.baseUrl, 'http://127.0.0.1:8080/api/latest/anthropic');
  assert.equal(r.head.requiresToken, true);
});

test('REJECT pxpipe with non-anthropic terminal', () => {
  const r = plan({ terminal: 'codex', compressors: ['pxpipe'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /pxpipe.*Fable|Fable.*pxpipe/i);
});

test('REJECT unknown terminal', () => {
  const r = plan({ terminal: 'llama', compressors: [] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /terminal/i);
});

test('REJECT unknown compressor id', () => {
  const r = plan({ terminal: 'anthropic', compressors: ['bogus'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /bogus/);
});

test('REJECT empty chain (no compressors, anthropic terminal → nothing to run)', () => {
  const r = plan({ terminal: 'anthropic', compressors: [] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /nothing to run|empty/i);
});

test('terminal router stage has no upstreamBase (uses provider, not a URL)', () => {
  const r = plan({ terminal: 'codex', compressors: [] });
  assert.equal(r.ok, true);
  assert.equal(r.chain[0].id, 'router');
  assert.equal(r.chain[0].upstreamBase, undefined);
  assert.equal(r.chain[0].provider, 'codex');
});

test('REJECT duplicate compressor', () => {
  const r = plan({ terminal: 'anthropic', compressors: ['headroom', 'headroom'] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /duplicate|headroom/i);
});
test('REJECT port collision', () => {
  const r = plan({ terminal: 'codex', compressors: ['headroom'], ports: { headroom: 8080, router: 8080 } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /8080|port/i);
});

test('sidecars include control by default and it is not part of the chain', () => {
  const r = plan({ terminal: 'anthropic', compressors: ['headroom'] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.chain.map((s) => s.id), ['headroom']);
  assert.ok(r.sidecars.some((s) => s.id === 'control'));
});

test('sidecars is empty when config.control.enabled is false', () => {
  const r = plan({ terminal: 'anthropic', compressors: ['headroom'], control: { enabled: false } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.sidecars, []);
});
