import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCompactRequest } from '../src/compact/matcher.js';

const compactUser =
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n' +
  'Your task is to create a detailed summary of the conversation so far, paying close attention to the user\'s explicit requests.';

test('matches a real compact request (string content)', () => {
  const body = { messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: compactUser },
  ] };
  assert.equal(isCompactRequest(body), true);
});

test('matches when last user content is blocks', () => {
  const body = { messages: [
    { role: 'user', content: [{ type: 'text', text: compactUser }] },
  ] };
  assert.equal(isCompactRequest(body), true);
});

test('does not match a normal user turn', () => {
  const body = { messages: [{ role: 'user', content: 'summarize this file for me' }] };
  assert.equal(isCompactRequest(body), false);
});

test('ignores the fingerprint in an assistant turn (must be last USER turn)', () => {
  const body = { messages: [
    { role: 'assistant', content: compactUser },
    { role: 'user', content: 'ok thanks' },
  ] };
  assert.equal(isCompactRequest(body), false);
});

test('handles empty/malformed bodies', () => {
  assert.equal(isCompactRequest({}), false);
  assert.equal(isCompactRequest({ messages: [] }), false);
});
