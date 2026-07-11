import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendReqLog, readReqLog, summarizeBody, type ReqLogEntry } from '../src/control/reqlog.ts';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-reqlog-'));
  return join(dir, 'requests.jsonl');
}

function entry(overrides: Partial<ReqLogEntry> = {}): ReqLogEntry {
  return {
    ts: new Date().toISOString(),
    stage: 'rate-limiter',
    method: 'POST',
    path: '/v1/messages',
    action: 'forward',
    ...overrides,
  };
}

test('appendReqLog + readReqLog: newest-first round-trip of 3 entries', () => {
  const path = tmpFile();
  appendReqLog(entry({ path: '/one' }), { path });
  appendReqLog(entry({ path: '/two' }), { path });
  appendReqLog(entry({ path: '/three' }), { path });
  const out = readReqLog({ path });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.path), ['/three', '/two', '/one']);
});

test('readReqLog skips a malformed line and still returns the valid ones', () => {
  const path = tmpFile();
  appendReqLog(entry({ path: '/a' }), { path });
  appendFileSync(path, 'not json at all\n');
  appendReqLog(entry({ path: '/b' }), { path });
  const out = readReqLog({ path });
  assert.deepEqual(out.map((e) => e.path), ['/b', '/a']);
});

test('summarizeBody extracts model/max_tokens/preview/bodySha', () => {
  const raw = Buffer.from(
    JSON.stringify({ model: 'claude-fable-5', max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }),
  );
  const result = summarizeBody(raw);
  assert.equal(result.model, 'claude-fable-5');
  assert.equal(result.maxTokens, 1);
  assert.equal(result.preview, 'quota');
  assert.match(result.bodySha, /^[0-9a-f]{8}$/);
});

test('appendReqLog caps file size by truncating before appending', () => {
  const path = tmpFile();
  const maxBytes = 2000;
  const padding = 'x'.repeat(200);
  const total = 40;
  for (let i = 0; i < total; i++) {
    appendReqLog(entry({ path: `/entry-${i}`, preview: padding }), { path, maxBytes });
  }
  const size = statSync(path).size;
  assert.ok(size < maxBytes * 2, `expected size < ${maxBytes * 2}, got ${size}`);
  const out = readReqLog({ path });
  assert.equal(out[0]!.path, `/entry-${total - 1}`);
});
