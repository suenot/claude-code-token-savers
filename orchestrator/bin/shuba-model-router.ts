#!/usr/bin/env bun
import { createModelRouter } from '../src/router/server.ts';
import type { Routes } from '../src/router/classify.ts';

const port = Number(process.env.PORT || 47854);
const upstream = process.env.ROUTER_UPSTREAM || 'https://api.anthropic.com';

// The whole routes map arrives as one JSON env var — nested config does not fit
// discrete envs. A malformed value degrades to an empty (passthrough) router.
let routes: Routes = {};
if (process.env.ROUTER_ROUTES) {
  try {
    routes = JSON.parse(process.env.ROUTER_ROUTES) as Routes;
  } catch {
    process.stderr.write('[model-router] bad ROUTER_ROUTES JSON — passthrough\n');
  }
}

createModelRouter({ port, upstream, routes }).listen(port);
process.stderr.write(
  `[model-router] listening on 127.0.0.1:${port} → ${upstream} (routes: ${Object.keys(routes).join(',') || 'none'})\n`,
);
