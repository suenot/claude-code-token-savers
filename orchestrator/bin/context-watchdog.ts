#!/usr/bin/env bun
import { createWatchdog } from '../src/watchdog/server.ts';

const port = Number(process.env.PORT || 47851);
const upstream = process.env.WATCHDOG_UPSTREAM || 'https://api.anthropic.com';
const model = process.env.WATCHDOG_MODEL || 'a8e/auto';
const baseUrl = process.env.WATCHDOG_BASE_URL || 'http://localhost:8080/v1';
const envKey = process.env.WATCHDOG_ENV_KEY || 'A8E_API_KEY';
const thresholdTokens = Number(process.env.WATCHDOG_THRESHOLD || 300000);
const tailTurns = Number(process.env.WATCHDOG_TAIL_TURNS || 6);
// The local a8e router (README: /Users/suenot/projects/server/llm/README.md)
// runs with A8E_REQUIRE_AUTH=false — any non-empty key satisfies it.
const isLocalRouter = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(baseUrl);
const apiKey = process.env[envKey] ?? (isLocalRouter ? 'local-no-auth' : undefined);
if (!apiKey) {
  process.stderr.write(`[context-watchdog] missing API key: set ${envKey}\n`);
  process.exit(1);
}
createWatchdog({ port, upstream, model, baseUrl, apiKey, thresholdTokens, tailTurns }).listen(port);
process.stderr.write(`[context-watchdog] listening on 127.0.0.1:${port} → ${upstream} (compact >${thresholdTokens}tok via ${model})\n`);
