import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCut } from '../src/watchdog/cut.js';

const U = (t) => ({ role: 'user', content: t });
const A = (t) => ({ role: 'assistant', content: t });
const TR = () => ({ role: 'user', content: [{ type: 'tool_result', content: 'x' }] });

test('clean boundary: tail is last tailTurns starting at a user msg', () => {
  const msgs = [U('1'), A('2'), U('3'), A('4'), U('5'), A('6')];
  const r = planCut(msgs, 2); // len 6, cut=4 → messages[4]=U('5') ok
  assert.deepEqual(r.tail.map((m) => m.content), ['5', '6']);
  assert.deepEqual(r.older.map((m) => m.content), ['1', '2', '3', '4']);
});

test('extends backward when boundary lands on assistant', () => {
  const msgs = [U('1'), A('2'), U('3'), A('4'), U('5'), A('6'), U('7'), A('8')];
  const r = planCut(msgs, 3); // len 8, cut=5 → A('6') not user → move to 4 U('5')
  assert.equal(r.tail[0].content, '5');
  assert.equal(r.older[r.older.length - 1].content, '4');
});

test('skips an orphan tool_result at the tail start', () => {
  const msgs = [U('1'), A('2'), U('3'), A('4'), TR(), A('6')];
  const r = planCut(msgs, 2); // cut=4 → TR() starts with tool_result → move back to U('3') at idx 2
  assert.equal(r.tail[0].content, '3');
});

test('returns null when nothing is older than the tail', () => {
  const msgs = [U('1'), A('2')];
  assert.equal(planCut(msgs, 5), null); // cut would be 0 → older empty
});

test('returns null for non-positive tailTurns (no crash)', () => {
  assert.equal(planCut([{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }], 0), null);
  assert.equal(planCut([{ role: 'user', content: '1' }], -3), null);
});
