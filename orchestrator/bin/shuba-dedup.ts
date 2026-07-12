#!/usr/bin/env bun
import { createDedup } from '../src/dedup/server.ts';

const port = Number(process.env.PORT || 47852);
const upstream = process.env.DEDUP_UPSTREAM || 'https://api.anthropic.com';

createDedup({ port, upstream }).listen(port);
process.stderr.write(`[dedup] listening on 127.0.0.1:${port} → ${upstream} (in-request block dedup)\n`);
