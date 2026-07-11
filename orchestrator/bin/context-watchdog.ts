#!/usr/bin/env bun
import { createWatchdog } from '../src/watchdog/server.ts';

const port = Number(process.env.PORT || 47851);
const upstream = process.env.WATCHDOG_UPSTREAM || 'https://api.anthropic.com';
const model = process.env.WATCHDOG_MODEL || 'deepseek/deepseek-v4-flash';
const baseUrl = process.env.WATCHDOG_BASE_URL || 'https://openrouter.ai/api/v1';
const envKey = process.env.WATCHDOG_ENV_KEY || 'OPENROUTER_API_KEY';
const thresholdTokens = Number(process.env.WATCHDOG_THRESHOLD || 300000);
const tailTurns = Number(process.env.WATCHDOG_TAIL_TURNS || 6);
const apiKey = process.env[envKey];
if (!apiKey) {
  process.stderr.write(`[context-watchdog] missing API key: set ${envKey}\n`);
  process.exit(1);
}
createWatchdog({ port, upstream, model, baseUrl, apiKey, thresholdTokens, tailTurns }).listen(port);
process.stderr.write(`[context-watchdog] listening on 127.0.0.1:${port} → ${upstream} (compact >${thresholdTokens}tok via ${model})\n`);
