#!/usr/bin/env bun
import { createCrush } from '../src/crush/server.ts';

const port = Number(process.env.PORT || 47855);
const upstream = process.env.CRUSH_UPSTREAM || 'https://api.anthropic.com';
const threshold = process.env.CRUSH_THRESHOLD ? Number(process.env.CRUSH_THRESHOLD) : undefined;
const budget = process.env.CRUSH_BUDGET ? Number(process.env.CRUSH_BUDGET) : undefined;
const enabled = process.env.CRUSH_ENABLED !== 'false';

createCrush({ port, upstream, threshold, budget, enabled }).listen(port);
process.stderr.write(`[crush] listening on 127.0.0.1:${port} → ${upstream} (tool_result crusher)\n`);
