import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendReqLog, readReqLog, readSavings, readSavingsFunnel, readCacheStats, parseUsage, summarizeBody, type ReqLogEntry } from '../src/control/reqlog.ts';

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

test('readSavings aggregates token telemetry overall and per stage; ignores untagged entries', () => {
  const path = tmpFile();
  // Entries without token fields are ignored (a plain forward).
  appendReqLog(entry({ stage: 'context-watchdog', action: 'forward' }), { path });
  appendReqLog(
    entry({ stage: 'context-watchdog', action: 'summarize', tokensIn: 1000, tokensOut: 400, tokensSaved: 600 }),
    { path },
  );
  // tokensSaved omitted → derived from in-out.
  appendReqLog(entry({ stage: 'dedup', action: 'dedup', tokensIn: 500, tokensOut: 300 }), { path });
  const s = readSavings({ path });
  assert.equal(s.requests, 2);
  assert.equal(s.totalIn, 1500);
  assert.equal(s.totalOut, 700);
  assert.equal(s.totalSaved, 800);
  assert.equal(s.byStage['context-watchdog']!.saved, 600);
  assert.equal(s.byStage['dedup']!.saved, 200);
  assert.equal(s.byStage['dedup']!.requests, 1);
});

test('readSavingsFunnel builds an ordered baseline→stage→sent funnel that closes on sent', () => {
  const path = tmpFile();
  // Two stages that actually removed tokens, plus an untagged forward (ignored).
  appendReqLog(entry({ stage: 'context-watchdog', action: 'forward' }), { path });
  appendReqLog(entry({ stage: 'compact-router', action: 'intercept', tokensIn: 1000, tokensOut: 700, tokensSaved: 300 }), { path });
  appendReqLog(entry({ stage: 'dedup', action: 'dedup', tokensIn: 700, tokensOut: 500 }), { path });

  const f = readSavingsFunnel({ path });
  assert.equal(f.baseline, 1700); // totalIn (1000 + 700)
  assert.equal(f.sent, 1200); // totalOut (700 + 500)
  assert.equal(f.totalSaved, 500); // baseline - sent
  assert.equal(f.requests, 2);

  // baseline + compact-router + dedup, in canonical order; last is terminal == sent.
  assert.deepEqual(f.stages.map((s) => s.name), ['Would-be-sent', 'compact-router', 'dedup']);
  assert.equal(f.stages[0]!.kind, 'baseline');
  assert.equal(f.stages[0]!.remaining, 1700);
  assert.equal(f.stages[1]!.saved, 300);
  assert.equal(f.stages[1]!.remaining, 1400); // 1700 - 300
  assert.equal(f.stages[2]!.saved, 200);
  assert.equal(f.stages[2]!.remaining, 1200); // 1400 - 200 == sent
  assert.equal(f.stages[2]!.terminal, true);
  // pctOfBaseline is monotonically non-increasing top→bottom.
  const pcts = f.stages.map((s) => s.pctOfBaseline);
  assert.ok(pcts[0]! >= pcts[1]! && pcts[1]! >= pcts[2]!);
});

test('readSavingsFunnel returns an empty funnel when there is no telemetry', () => {
  const path = tmpFile();
  appendReqLog(entry({ stage: 'rate-limiter', action: 'forward' }), { path });
  const f = readSavingsFunnel({ path });
  assert.equal(f.baseline, 0);
  assert.equal(f.sent, 0);
  assert.deepEqual(f.stages, []);
});

test('reqlog entry round-trips cache/usage fields', () => {
  const path = tmpFile();
  appendReqLog(
    entry({ inputTokens: 1200, outputTokens: 300, cacheRead: 900, cacheWrite: 100 }),
    { path },
  );
  const out = readReqLog({ path });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.inputTokens, 1200);
  assert.equal(out[0]!.outputTokens, 300);
  assert.equal(out[0]!.cacheRead, 900);
  assert.equal(out[0]!.cacheWrite, 100);
});

test('parseUsage reads usage from a non-streaming JSON response', () => {
  const body = JSON.stringify({
    id: 'msg_1',
    usage: {
      input_tokens: 50,
      output_tokens: 120,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300,
    },
  });
  const u = parseUsage(body, 'application/json')!;
  assert.deepEqual(u, { inputTokens: 50, outputTokens: 120, cacheRead: 2000, cacheWrite: 300 });
});

test('parseUsage reads usage from an SSE stream (message_start + message_delta)', () => {
  const sse = [
    'event: message_start',
    'data: ' + JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 } },
    }),
    '',
    'event: ping',
    'data: {"type":"ping"}',
    '',
    'event: message_delta',
    'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 210 } }),
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const u = parseUsage(sse, 'text/event-stream')!;
  // input/cache come from message_start; output_tokens overridden by the final delta.
  assert.equal(u.inputTokens, 40);
  assert.equal(u.cacheRead, 1500);
  assert.equal(u.cacheWrite, 0);
  assert.equal(u.outputTokens, 210);
});

test('parseUsage returns undefined when there is no usage', () => {
  assert.equal(parseUsage('', 'application/json'), undefined);
  assert.equal(parseUsage('not json', 'application/json'), undefined);
  assert.equal(parseUsage(JSON.stringify({ id: 'x' }), 'application/json'), undefined);
});

test('readCacheStats aggregates usage; ignores entries without it', () => {
  const path = tmpFile();
  // A plain forward with no usage is ignored.
  appendReqLog(entry({ action: 'forward' }), { path });
  appendReqLog(entry({ inputTokens: 1000, outputTokens: 200, cacheRead: 800, cacheWrite: 50 }), { path });
  appendReqLog(entry({ inputTokens: 500, outputTokens: 100, cacheRead: 200, cacheWrite: 0 }), { path });
  const s = readCacheStats({ path });
  assert.equal(s.requests, 2);
  assert.equal(s.totalInput, 1500);
  assert.equal(s.totalOutput, 300);
  assert.equal(s.totalCacheRead, 1000);
  assert.equal(s.totalCacheWrite, 50);
  assert.equal(s.totalProcessed, 2550); // 1500 + 1000 + 50 (input + cacheRead + cacheWrite, additive)
  assert.equal(s.freshInput, 1550); // 1500 + 50 (uncached input + cache writes, paid full-or-higher)
  assert.ok(Math.abs(s.cacheHitRatio - 1000 / 2550) < 1e-9); // cacheRead / totalProcessed
});

test('readCacheStats returns zeros when there is no usage telemetry', () => {
  const path = tmpFile();
  appendReqLog(entry({ action: 'forward' }), { path });
  const s = readCacheStats({ path });
  assert.equal(s.requests, 0);
  assert.equal(s.cacheHitRatio, 0);
  assert.equal(s.freshInput, 0);
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
