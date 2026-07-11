#!/usr/bin/env bun
import { createInterceptor } from '../src/compact/server.ts';

const port = Number(process.env.PORT || 47850);
const upstream = process.env.COMPACT_UPSTREAM || 'https://api.anthropic.com';
const model = process.env.COMPACT_MODEL || 'deepseek/deepseek-v4-flash';
const baseUrl = process.env.COMPACT_BASE_URL || 'https://openrouter.ai/api/v1';
const envKey = process.env.COMPACT_ENV_KEY || 'OPENROUTER_API_KEY';
const apiKey = process.env[envKey];
if (!apiKey) {
  process.stderr.write(`[compact-router] missing API key: set ${envKey}\n`);
  process.exit(1);
}
const server = createInterceptor({ port, upstream, model, baseUrl, apiKey });
server.listen(port);
process.stderr.write(`[compact-router] listening on 127.0.0.1:${port} → ${upstream} (compact→${model})\n`);
