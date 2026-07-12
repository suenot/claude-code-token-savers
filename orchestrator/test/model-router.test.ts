import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest, hasImage, type Routes } from '../src/router/classify.ts';
import { applyRoute } from '../src/router/apply.ts';

const imgBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const withImage = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: [imgBlock] }] };
const textReq = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

// A spawn stub standing in for tesseract: returns fixed text, status 0.
const fakeSpawn: any = () => ({ status: 0, stdout: 'EXTRACTED TEXT', stderr: '' });

test('hasImage detects base64 image blocks', () => {
  assert.equal(hasImage(withImage), true);
  assert.equal(hasImage(textReq), false);
});

test('classify: unconfigured categories never shadow', () => {
  // image present but no image route configured → default
  assert.equal(classifyRequest(withImage, {}), 'default');
  // configure image → image wins
  assert.equal(classifyRequest(withImage, { image: { mode: 'ocr' } }), 'image');
});

test('classify: longContext precedence over image when both configured', () => {
  const routes: Routes = { image: { mode: 'ocr' }, longContext: { model: 'lc', threshold: 5 } };
  const big = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }, imgBlock] }] };
  assert.equal(classifyRequest(big, routes), 'longContext');
});

test('classify: think / webSearch / background detection', () => {
  assert.equal(classifyRequest({ thinking: { type: 'enabled' }, messages: [] }, { think: { model: 't' } }), 'think');
  assert.equal(
    classifyRequest({ tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [] }, { webSearch: { model: 'w' } }),
    'webSearch',
  );
  assert.equal(classifyRequest({ model: 'claude-haiku-4-5', messages: [] }, { background: { model: 'bg' } }), 'background');
  // background not configured → default
  assert.equal(classifyRequest({ model: 'claude-haiku-4-5', messages: [] }, {}), 'default');
});

test('applyRoute: known-provider target strips provider into the endpoint', () => {
  // deepseek is a known provider -> body.model is the bare model, endpoint set.
  const { body, stats, upstream } = applyRoute({ model: 'claude-haiku-4-5', messages: [] }, 'background', { background: { model: 'deepseek/x' } });
  assert.equal(body.model, 'x');
  assert.equal(stats.routedModel, 'x');
  assert.equal(upstream?.baseUrl, 'https://api.deepseek.com');
});

test('applyRoute: unknown-provider target passes through as body.model', () => {
  const { body } = applyRoute({ model: 'claude-haiku-4-5', messages: [] }, 'background', { background: { model: 'someprov/x' } });
  assert.equal(body.model, 'someprov/x');
});

test('applyRoute: explicit baseUrl override wins over the provider registry', () => {
  const { upstream } = applyRoute(textReq, 'default', { default: { model: 'm', baseUrl: 'http://x', envKey: 'K' } });
  assert.deepEqual(upstream, { baseUrl: 'http://x', envKey: 'K' });
});

test('applyRoute image OCR: injects a text block, keeps image by default', () => {
  const { body, stats } = applyRoute(withImage, 'image', { image: { mode: 'ocr' } }, { spawnImpl: fakeSpawn });
  const content = body.messages[0].content;
  assert.equal(content.length, 2, 'text block inserted before image');
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /shuba-ocr/);
  assert.match(content[0].text, /EXTRACTED TEXT/);
  assert.equal(content[1].type, 'image');
  assert.equal(stats.ocrImages, 1);
});

test('applyRoute image OCR dropImage: removes the pixels', () => {
  const { body, stats } = applyRoute(withImage, 'image', { image: { mode: 'ocr', dropImage: true } }, { spawnImpl: fakeSpawn });
  const content = body.messages[0].content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
  assert.ok(stats.tokensSaved >= 0);
});

test('applyRoute image vision-route: rewrites model, leaves content', () => {
  const { body, stats } = applyRoute(withImage, 'image', { image: { mode: 'vision-route', model: 'claude-haiku-4-5' } });
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(stats.routedModel, 'claude-haiku-4-5');
  assert.equal(body.messages[0].content[0].type, 'image', 'image kept');
});

test('applyRoute image off: passthrough', () => {
  const { body } = applyRoute(withImage, 'image', { image: { mode: 'off' } }, { spawnImpl: fakeSpawn });
  assert.equal(body.messages[0].content.length, 1);
  assert.equal(body.messages[0].content[0].type, 'image');
});

test('applyRoute image auto: text mentions OCR -> local extraction', () => {
  const req = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: [{ type: 'text', text: 'do OCR on this' }, imgBlock] }] };
  const { stats } = applyRoute(req, 'image', { image: { mode: 'auto' } }, { spawnImpl: fakeSpawn });
  assert.equal(stats.ocrImages, 1);
});

test('applyRoute image auto: no OCR keyword + vision model -> route to it', () => {
  const req = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is in this picture?' }, imgBlock] }] };
  const { body, stats } = applyRoute(req, 'image', { image: { mode: 'auto', model: 'a8e/a8e-1.0-pro' } }, { spawnImpl: fakeSpawn });
  assert.equal(stats.ocrImages, 0);
  assert.equal(body.model, 'a8e/a8e-1.0-pro');
});

test('applyRoute image auto: no OCR keyword + no vision model -> passthrough', () => {
  const req = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: [{ type: 'text', text: 'describe it' }, imgBlock] }] };
  const { body, stats } = applyRoute(req, 'image', { image: { mode: 'auto' } }, { spawnImpl: fakeSpawn });
  assert.equal(stats.ocrImages, 0);
  assert.equal(body.model, 'claude-opus-4-8');
});

// --- thinking damper ---------------------------------------------------------

const thinkingReq = (budget?: number) => ({
  model: 'claude-haiku-4-5',
  messages: [],
  ...(budget === undefined ? {} : { thinking: { type: 'enabled', budget_tokens: budget } }),
});

test('damper strip: removes the thinking param and reports the removed budget', () => {
  const { body, stats } = applyRoute(thinkingReq(4000), 'background', { background: { model: 'bg', thinking: 'strip' } });
  assert.equal('thinking' in body, false, 'thinking removed');
  assert.equal(stats.thinkingAction, 'strip');
  assert.equal(stats.thinkingSaved, 4000);
});

test('damper cap: lowers a budget over the cap to the cap', () => {
  const { body, stats } = applyRoute(thinkingReq(10000), 'think', { think: { model: 't', thinking: { budget: 2000 } } });
  assert.equal(body.thinking.budget_tokens, 2000);
  assert.equal(stats.thinkingAction, 'cap');
  assert.equal(stats.thinkingSaved, 8000);
});

test('damper cap: leaves a budget at or below the cap alone', () => {
  const { body, stats } = applyRoute(thinkingReq(1500), 'think', { think: { model: 't', thinking: { budget: 2000 } } });
  assert.equal(body.thinking.budget_tokens, 1500, 'unchanged');
  assert.equal(stats.thinkingAction, undefined);
  assert.equal(stats.thinkingSaved, 0);
});

test('damper cap: absent thinking stays absent (never added)', () => {
  const { body, stats } = applyRoute(thinkingReq(undefined), 'think', { think: { model: 't', thinking: { budget: 2000 } } });
  assert.equal('thinking' in body, false);
  assert.equal(stats.thinkingAction, undefined);
});

test('damper strip: absent thinking stays absent', () => {
  const { body, stats } = applyRoute(thinkingReq(undefined), 'background', { background: { model: 'bg', thinking: 'strip' } });
  assert.equal('thinking' in body, false);
  assert.equal(stats.thinkingAction, undefined);
  assert.equal(stats.thinkingSaved, 0);
});

test('damper: non-configured route leaves thinking untouched', () => {
  const { body, stats } = applyRoute(thinkingReq(5000), 'think', { think: { model: 't' } });
  assert.equal(body.thinking.budget_tokens, 5000);
  assert.equal(stats.thinkingAction, undefined);
});

test('damper: background category strips thinking by default', () => {
  const { body, stats } = applyRoute(thinkingReq(3000), 'background', { background: { model: 'bg' } });
  assert.equal('thinking' in body, false, 'stripped without explicit config');
  assert.equal(stats.thinkingAction, 'strip');
  assert.equal(stats.thinkingSaved, 3000);
});

test('damper: background route can opt out with keep', () => {
  const { body, stats } = applyRoute(thinkingReq(3000), 'background', { background: { model: 'bg', thinking: 'keep' } });
  assert.equal(body.thinking.budget_tokens, 3000, 'preserved');
  assert.equal(stats.thinkingAction, undefined);
});

test('damper strip: enabled thinking without a budget still strips (0 saved)', () => {
  const req = { model: 'claude-haiku-4-5', messages: [], thinking: { type: 'enabled' } };
  const { body, stats } = applyRoute(req, 'background', { background: { model: 'bg' } });
  assert.equal('thinking' in body, false);
  assert.equal(stats.thinkingAction, 'strip');
  assert.equal(stats.thinkingSaved, 0);
});
