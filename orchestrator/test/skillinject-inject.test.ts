import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BlockCache,
  buildBlock,
  firstUserText,
  injectRequest,
  selectionKey,
  type CapabilityEntry,
} from '../src/skillinject/inject.ts';

const manifest: CapabilityEntry[] = [
  { id: 'seo', type: 'skill', name: 'SEO Audit', description: 'analyze a website for SEO', enabled: true },
  { id: 'graphify', type: 'skill', name: 'Graphify', description: 'turn a codebase into a knowledge graph', enabled: true },
  { id: 'disabled-one', type: 'skill', name: 'Off', description: 'should never appear', enabled: false },
  { id: 'some-agent', type: 'agent', name: 'Agent', description: 'not a skill', enabled: true },
];

const body = () => ({
  model: 'claude-opus-4-8',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'Please run an SEO audit on my site' }],
});

// A classifier fetch double that returns the given ids and counts invocations.
function classifierReturning(ids: string[]) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ ids }) } }] }),
    };
  }) as any;
  return { fetchImpl, calls: () => calls };
}

test('firstUserText handles string and block content', () => {
  assert.equal(firstUserText(body()), 'Please run an SEO audit on my site');
  assert.equal(
    firstUserText({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }),
    'ab',
  );
  assert.equal(firstUserText({ messages: [] }), '');
});

test('buildBlock renders name, description, absolute SKILL.md path; empty → ""', () => {
  const block = buildBlock([manifest[0]!], '/store');
  assert.match(block, /SEO Audit: analyze a website for SEO/);
  assert.match(block, /\/store\/skills\/seo\/SKILL\.md/);
  assert.equal(buildBlock([], '/store'), '');
});

test('selection → injection: appends an Available skills system block', async () => {
  const cache = new BlockCache();
  const { fetchImpl } = classifierReturning(['seo']);
  const { body: out, stats } = await injectRequest(body(), manifest, {
    cache,
    fetchImpl,
    storeDir: '/store',
  });
  assert.equal(stats.injected, true);
  assert.equal(stats.skillCount, 1);
  assert.equal(out.system, buildBlock([manifest[0]!], '/store'));
});

test('repeat request → byte-identical block, classifier called once (LRU hit)', async () => {
  const cache = new BlockCache();
  const c = classifierReturning(['seo', 'graphify']);
  const first = await injectRequest(body(), manifest, { cache, fetchImpl: c.fetchImpl, storeDir: '/store' });
  // A later turn: same conversation (same first user message + model), different tail.
  const laterBody = body();
  (laterBody.messages as any).push({ role: 'assistant', content: 'ok' });
  const second = await injectRequest(laterBody, manifest, { cache, fetchImpl: c.fetchImpl, storeDir: '/store' });
  assert.equal(c.calls(), 1, 'classifier called exactly once for the conversation');
  assert.equal(first.stats.classifierCalled, true);
  assert.equal(second.stats.classifierCalled, false);
  assert.equal(first.body.system, second.body.system, 'injected block byte-identical across turns');
});

test('fail open: classifier non-200 → no injection, not cached (recovers next call)', async () => {
  const cache = new BlockCache();
  let calls = 0;
  const failing = (async () => {
    calls++;
    return { ok: false };
  }) as any;
  const b = body();
  const { body: out, stats } = await injectRequest(b, manifest, { cache, fetchImpl: failing, storeDir: '/store' });
  assert.equal(stats.injected, false);
  assert.equal(out, b, 'body forwarded untouched on classifier failure');
  // Not cached: a second call tries the classifier again.
  await injectRequest(body(), manifest, { cache, fetchImpl: failing, storeDir: '/store' });
  assert.equal(calls, 2);
});

test('classifier returns [] → cached passthrough, no re-call', async () => {
  const cache = new BlockCache();
  const c = classifierReturning([]);
  const r1 = await injectRequest(body(), manifest, { cache, fetchImpl: c.fetchImpl, storeDir: '/store' });
  const r2 = await injectRequest(body(), manifest, { cache, fetchImpl: c.fetchImpl, storeDir: '/store' });
  assert.equal(r1.stats.injected, false);
  assert.equal(r2.stats.injected, false);
  assert.equal(c.calls(), 1, 'empty selection cached — classifier not re-called');
});

test('no enabled skills in manifest → passthrough, classifier never called', async () => {
  const cache = new BlockCache();
  let calls = 0;
  const spy = (async () => {
    calls++;
    return { ok: true, json: async () => ({}) };
  }) as any;
  const onlyAgents: CapabilityEntry[] = [manifest[3]!, manifest[2]!];
  const b = body();
  const { body: out, stats } = await injectRequest(b, onlyAgents, { cache, fetchImpl: spy });
  assert.equal(stats.injected, false);
  assert.equal(out, b);
  assert.equal(calls, 0);
});

test('maxSkills caps the number of injected skills', async () => {
  const cache = new BlockCache();
  const c = classifierReturning(['seo', 'graphify']);
  const { body: out, stats } = await injectRequest(body(), manifest, {
    cache,
    fetchImpl: c.fetchImpl,
    storeDir: '/store',
    maxSkills: 1,
  });
  assert.equal(stats.skillCount, 1);
  assert.equal(out.system, buildBlock([manifest[0]!], '/store'));
});

test('unknown / disabled ids from the classifier are filtered out', async () => {
  const cache = new BlockCache();
  const c = classifierReturning(['nope', 'disabled-one', 'graphify']);
  const { body: out, stats } = await injectRequest(body(), manifest, {
    cache,
    fetchImpl: c.fetchImpl,
    storeDir: '/store',
  });
  assert.equal(stats.skillCount, 1);
  assert.equal(out.system, buildBlock([manifest[1]!], '/store'));
});

test('appendSystemBlock preserves an existing array-form system', async () => {
  const cache = new BlockCache();
  const c = classifierReturning(['seo']);
  const b: any = { ...body(), system: [{ type: 'text', text: 'base' }] };
  const { body: out } = await injectRequest(b, manifest, { cache, fetchImpl: c.fetchImpl, storeDir: '/store' });
  assert.equal(out.system.length, 2);
  assert.equal(out.system[0].text, 'base');
  assert.match(out.system[1].text, /Available skills/);
});

test('selectionKey is stable and separates by model', () => {
  assert.equal(selectionKey('hi', 'm'), selectionKey('hi', 'm'));
  assert.notEqual(selectionKey('hi', 'm1'), selectionKey('hi', 'm2'));
});
