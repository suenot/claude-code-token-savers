import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { resolveScale, DEFAULT_SCALE } from '../src/image/presets.ts';
import { shrinkBody } from '../src/image/shrink.ts';
import { readSavings } from '../src/control/reqlog.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A solid-color PNG of the given size, as a base64 string.
async function pngBase64(width: number, height: number): Promise<string> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return buf.toString('base64');
}

function imageBlock(data: string, mediaType = 'image/png') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

test('resolveScale: presets, raw numbers, garbage', () => {
  assert.equal(resolveScale('1/2'), 0.5);
  assert.equal(resolveScale('1/4'), 0.25);
  assert.equal(resolveScale('1/2.5'), 0.4);
  assert.equal(resolveScale(0.3), 0.3);
  assert.equal(resolveScale('0.3'), 0.3);
  assert.equal(resolveScale(undefined), DEFAULT_SCALE);
  assert.equal(resolveScale(0), DEFAULT_SCALE);
  assert.equal(resolveScale(2), DEFAULT_SCALE);
  assert.equal(resolveScale('nonsense'), DEFAULT_SCALE);
});

test('shrinkBody: downscales a base64 PNG by the scale factor', async () => {
  const data = await pngBase64(400, 400);
  const body = { model: 'claude-opus-4-8', messages: [{ role: 'user', content: [imageBlock(data)] }] };
  const { body: out, stats } = await shrinkBody(body, { scale: 0.5, minBytes: 0 });

  assert.equal(stats.images, 1);
  assert.ok(stats.savedBytes > 0, 'expected bytes saved');
  assert.ok(stats.tokensBefore > stats.tokensAfter, 'expected token estimate to drop');

  const newData = out.messages[0].content[0].source.data as string;
  const meta = await sharp(Buffer.from(newData, 'base64')).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 200);
});

test('shrinkBody: text and non-image blocks are untouched', async () => {
  const body = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'tool_result', content: 'x' }] }],
  };
  const { body: out, stats } = await shrinkBody(body, { scale: 0.5 });
  assert.equal(stats.images, 0);
  assert.deepEqual(out, body);
});

test('shrinkBody: url-source images are skipped', async () => {
  const body = {
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
  };
  const { stats } = await shrinkBody(body, { scale: 0.5 });
  assert.equal(stats.images, 0);
});

test('shrinkBody: scale >= 1 is a passthrough', async () => {
  const data = await pngBase64(400, 400);
  const body = { messages: [{ role: 'user', content: [imageBlock(data)] }] };
  const { body: out, stats } = await shrinkBody(body, { scale: 1 });
  assert.equal(stats.images, 0);
  assert.equal(out, body);
});

test('shrinkBody: images below minBytes are skipped', async () => {
  const data = await pngBase64(400, 400);
  const bytes = Buffer.byteLength(data, 'base64');
  const body = { messages: [{ role: 'user', content: [imageBlock(data)] }] };
  const { stats } = await shrinkBody(body, { scale: 0.5, minBytes: bytes + 1 });
  assert.equal(stats.images, 0);
});

test('readSavings: aggregates tokensSaved per model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-savings-'));
  const path = join(dir, 'requests.jsonl');
  const lines = [
    { ts: '1', stage: 'image-shrink', method: 'POST', path: '/v1/messages', action: 'forward', model: 'claude-opus-4-8', tokensIn: 1000, tokensOut: 250, tokensSaved: 750 },
    { ts: '2', stage: 'image-shrink', method: 'POST', path: '/v1/messages', action: 'forward', model: 'claude-sonnet-5', tokensIn: 400, tokensOut: 100, tokensSaved: 300 },
    { ts: '3', stage: 'image-shrink', method: 'POST', path: '/v1/messages', action: 'forward', model: 'claude-opus-4-8', tokensIn: 200, tokensOut: 50, tokensSaved: 150 },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const s = readSavings({ path });
  assert.equal(s.totalSaved, 1200);
  assert.equal(s.byModel['claude-opus-4-8'].saved, 900);
  assert.equal(s.byModel['claude-opus-4-8'].requests, 2);
  assert.equal(s.byModel['claude-sonnet-5'].saved, 300);
  assert.equal(s.byStage['image-shrink'].saved, 1200);
});
