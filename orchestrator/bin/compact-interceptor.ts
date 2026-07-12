#!/usr/bin/env bun
import { createInterceptor } from '../src/compact/server.ts';

const port = Number(process.env.PORT || 47850);
const upstream = process.env.COMPACT_UPSTREAM || 'https://api.anthropic.com';
const model = process.env.COMPACT_MODEL || 'a8e/auto';
const baseUrl = process.env.COMPACT_BASE_URL || 'http://localhost:8080/v1';
const envKey = process.env.COMPACT_ENV_KEY || 'A8E_API_KEY';
// The local a8e router (README: /Users/suenot/projects/server/llm/README.md)
// runs with A8E_REQUIRE_AUTH=false — any non-empty key satisfies it.
const isLocalRouter = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(baseUrl);
const apiKey = process.env[envKey] ?? (isLocalRouter ? 'local-no-auth' : undefined);
if (!apiKey) {
  process.stderr.write(`[compact-router] missing API key: set ${envKey}\n`);
  process.exit(1);
}
const server = createInterceptor({ port, upstream, model, baseUrl, apiKey });
server.listen(port);
process.stderr.write(`[compact-router] listening on 127.0.0.1:${port} → ${upstream} (compact→${model})\n`);
