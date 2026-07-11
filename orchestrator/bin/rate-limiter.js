#!/usr/bin/env node
import { createRateLimiter } from '../src/ratelimit/server.js';

const port = Number(process.env.PORT || 47840);
const upstream = process.env.RATELIMIT_UPSTREAM || 'https://api.anthropic.com';
const rps = Number(process.env.RATELIMIT_RPS || 2);
const burst = Number(process.env.RATELIMIT_BURST || 5);
const default429CooldownMs = Number(process.env.RATELIMIT_COOLDOWN_MS || 5000);

createRateLimiter({ port, upstream, rps, burst, default429CooldownMs }).listen(port);
process.stderr.write(
  `[rate-limiter] listening on 127.0.0.1:${port} → ${upstream} (${rps} rps, burst ${burst}, 429 cooldown ${default429CooldownMs}ms)\n`,
);
