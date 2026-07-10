import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken } from '../src/router-bootstrap.js';

test('mintToken posts to /api/tokens and returns the token', async () => {
  const seen = {};
  const fetchImpl = async (url, opts) => {
    seen.url = url;
    seen.method = opts?.method;
    return { ok: true, json: async () => ({ token: 'la_sk_abc123' }) };
  };
  const token = await mintToken('http://127.0.0.1:8080', { fetchImpl });
  assert.equal(token, 'la_sk_abc123');
  assert.equal(seen.url, 'http://127.0.0.1:8080/api/tokens');
  assert.equal(seen.method, 'POST');
});

test('mintToken throws body on failure', async () => {
  const fetchImpl = async () => ({ ok: false, text: async () => 'nope' });
  await assert.rejects(mintToken('http://127.0.0.1:8080', { fetchImpl }), /nope/);
});
