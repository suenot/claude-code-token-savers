import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { configPath } from '../config.ts';
import type { Config } from '../types.ts';

// Live on/off switches for shuba chain stages. Written to a small runtime.json
// file (separate from the persisted ~/.shuba/chain.json config) so a running
// stage can be flipped off/on from the console without a restart. Every read
// here is guarded — a missing or malformed file must never throw into the hot
// proxy path — and isStageEnabled caches the parsed file for ~1s (keyed off
// mtime) since it is called on every proxied request.

export type Toggles = Record<string, boolean>;

export function runtimePath(): string {
  return process.env.SHUBA_RUNTIME ?? join(homedir(), '.shuba', 'runtime.json');
}

function readTogglesUnguarded(path: string): Toggles {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Toggles = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export function readToggles(path: string = runtimePath()): Toggles {
  try {
    return readTogglesUnguarded(path);
  } catch {
    return {};
  }
}

type CacheEntry = { mtimeMs: number; toggles: Toggles; readAt: number };
const CACHE_TTL_MS = 1000;
const fileCache = new Map<string, CacheEntry>();

export function isStageEnabled(stageId: string, path: string = runtimePath()): boolean {
  try {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = -1; // file absent
    }
    const now = Date.now();
    const cached = fileCache.get(path);
    let toggles: Toggles;
    if (cached && cached.mtimeMs === mtimeMs && now - cached.readAt < CACHE_TTL_MS) {
      toggles = cached.toggles;
    } else {
      toggles = readToggles(path);
      fileCache.set(path, { mtimeMs, toggles, readAt: now });
    }
    const value = toggles[stageId];
    return value === undefined ? true : value;
  } catch {
    return true;
  }
}

export function setToggle(stageId: string, enabled: boolean, path: string = runtimePath()): Toggles {
  const current = readToggles(path);
  current[stageId] = enabled;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(current, null, 2));
  fileCache.delete(path); // pick up the change immediately, cache re-warms on next read
  return current;
}

// Persists a toggle into the durable chain.json config (in addition to the
// live runtime.json written by setToggle), so the choice survives a restart.
// Reads + merges + writes back, guarded against a missing/malformed file.
export function persistToggle(stage: string, enabled: boolean, chainPath: string = configPath()): void {
  let config: Config;
  try {
    config = existsSync(chainPath)
      ? (JSON.parse(readFileSync(chainPath, 'utf8')) as Config)
      : { terminal: 'anthropic', compressors: ['headroom'] };
  } catch {
    config = { terminal: 'anthropic', compressors: ['headroom'] };
  }
  config.toggles = { ...(config.toggles ?? {}), [stage]: enabled };
  mkdirSync(dirname(chainPath), { recursive: true });
  writeFileSync(chainPath, JSON.stringify(config, null, 2));
}
