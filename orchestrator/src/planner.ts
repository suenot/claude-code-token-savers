import { REGISTRY } from './registry.ts';
import type { Config, StageDescriptor, PlannedStage, PlanResult } from './types.ts';

const TERMINALS = new Set(['anthropic', 'codex', 'gemini', 'qwen', 'openai-compatible']);
const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';

function baseUrlFor(descriptor: StageDescriptor, port: number): string {
  const root = `http://127.0.0.1:${port}`;
  return descriptor.clientPathSuffix ? root + descriptor.clientPathSuffix : root;
}

export function plan(config: Config, registry: Record<string, StageDescriptor> = REGISTRY): PlanResult {
  const errors: string[] = [];
  const terminal = config.terminal;
  const compressors = config.compressors ?? [];
  const ports = config.ports ?? {};

  if (!TERMINALS.has(terminal)) {
    errors.push(`unknown terminal "${terminal}" (expected one of ${[...TERMINALS].join(', ')})`);
  }
  for (const id of compressors) {
    if (!registry[id] || registry[id].terminal) errors.push(`unknown compressor id "${id}"`);
  }
  if (compressors.includes('pxpipe') && terminal !== 'anthropic') {
    errors.push('pxpipe requires terminal "anthropic" — imaged content is Fable-only and non-Anthropic providers cannot read it');
  }

  // Build the ordered list of descriptor ids: compressors first, router appended when translating.
  const orderIds = [...compressors];
  if (terminal !== 'anthropic') orderIds.push('router');

  if (orderIds.length === 0) {
    errors.push('nothing to run — an anthropic terminal with no compressors is an empty chain');
  }

  // Duplicate compressor ids.
  const seen = new Set<string>();
  for (const id of compressors) {
    if (seen.has(id)) errors.push(`duplicate compressor id "${id}" — each compressor may appear at most once`);
    seen.add(id);
  }

  if (errors.length) return { ok: false, errors };

  // Assign ports and precompute each stage's baseUrl.
  const staged = orderIds.map((id) => {
    const d = registry[id];
    const port = ports[id] ?? d.defaultPort;
    return { d, id, port, baseUrl: baseUrlFor(d, port) };
  });

  // Port collisions: two stages resolving to the same port.
  const portOwners = new Map<number, string[]>();
  for (const s of staged) {
    if (!portOwners.has(s.port)) portOwners.set(s.port, []);
    portOwners.get(s.port)!.push(s.id);
  }
  for (const [port, ids] of portOwners) {
    if (ids.length > 1) {
      errors.push(`port collision on ${port}: ${ids.join(', ')} all resolve to the same port`);
    }
  }

  if (errors.length) return { ok: false, errors };

  // Wire upstreams: each stage forwards to the next stage's baseUrl; the terminal
  // anthropic stage forwards to the real Anthropic API. The router is terminal and
  // takes provider instead of an upstreamBase.
  const chain: PlannedStage[] = staged.map((s, i) => {
    const next = staged[i + 1];
    const provider = s.d.terminal && terminal !== 'anthropic' ? terminal : undefined;
    const upstreamBase = next ? next.baseUrl : (provider ? undefined : ANTHROPIC_UPSTREAM);
    const { args, env } = s.d.build({ port: s.port, upstreamBase, provider, config });
    return {
      id: s.id,
      port: s.port,
      baseUrl: s.baseUrl,
      upstreamBase,
      provider,
      healthUrl: `http://127.0.0.1:${s.port}${s.d.healthPath}`,
      spawn: { bin: s.d.bin, args, env },
    };
  });

  const requiresToken = chain.some((s) => registry[s.id].requiresToken);

  // Sidecars run alongside the proxy chain but are not part of it — they don't
  // forward/receive chain traffic. `control` is enabled by default.
  const sidecars: PlannedStage[] = [];
  if (config.control?.enabled !== false && registry.control) {
    const d = registry.control;
    const sidecarPorts = ports;
    const port = sidecarPorts[d.id] ?? d.defaultPort;
    const { args, env } = d.build({ port, config });
    sidecars.push({
      id: d.id,
      port,
      baseUrl: baseUrlFor(d, port),
      healthUrl: `http://127.0.0.1:${port}${d.healthPath}`,
      spawn: { bin: d.bin, args, env },
    });
  }

  return { ok: true, chain, sidecars, head: { baseUrl: chain[0].baseUrl, requiresToken } };
}
