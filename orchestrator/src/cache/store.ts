import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// Content-hash disk cache: memoizes expensive, LLM-billed compression outputs
// (e.g. conversation summaries) so that identical/unchanged inputs cost zero
// LLM tokens on repeat. Ported from graphify's cache.py. Like reqlog.ts every
// operation here is best-effort and never throws — a cache miss (or a cache
// bug) must never break the proxy's real response path; the worst outcome is
// paying for the LLM call again.
//
// On-disk layout: <dir>/<ab>/<full-sha256>.json where <ab> is the first two
// hex chars of the hash, sharding entries so one flat directory never grows
// unbounded. Each file is a small JSON envelope { v: <value>, ts: <number> }.

export type CacheKey = {
  namespace: string;
  content: string;
  // Present for deterministic transforms: a bump invalidates every prior
  // entry for that namespace. Omit for LLM-derived output so a shuba release
  // never invalidates it and never re-triggers billing (content-only hash).
  algoVersion?: string;
};

type Envelope = { v: string; ts: number };

export interface Cache {
  get(key: CacheKey): string | null;
  set(key: CacheKey, value: string): void;
  has(key: CacheKey): boolean;
}

const NUL = '\0';

function defaultDir(): string {
  return join(homedir(), '.shuba', 'cache');
}

// Namespacing rule (critical): with algoVersion the hash folds it in so a
// version bump invalidates; without it the hash is content-only so it is
// stable across shuba releases.
function hashKey(key: CacheKey): string {
  const parts =
    key.algoVersion !== undefined
      ? [key.namespace, key.algoVersion, key.content]
      : [key.namespace, key.content];
  return createHash('sha256').update(parts.join(NUL)).digest('hex');
}

export function createCache(opts?: { dir?: string; now?: () => number }): Cache {
  const dir = opts?.dir ?? defaultDir();
  const now = opts?.now ?? Date.now;

  function pathFor(key: CacheKey): { shard: string; file: string } {
    const hash = hashKey(key);
    const shard = join(dir, hash.slice(0, 2));
    return { shard, file: join(shard, `${hash}.json`) };
  }

  function get(key: CacheKey): string | null {
    try {
      const { file } = pathFor(key);
      if (!existsSync(file)) return null;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Envelope;
      if (parsed && typeof parsed.v === 'string') return parsed.v;
      return null;
    } catch {
      // Corrupt/partial file, unreadable path, bad JSON — treat as a miss.
      return null;
    }
  }

  function set(key: CacheKey, value: string): void {
    try {
      const { shard, file } = pathFor(key);
      mkdirSync(shard, { recursive: true });
      const envelope: Envelope = { v: value, ts: now() };
      const tmp = `${file}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(envelope));
      // renameSync is atomic within a filesystem, so a reader never sees a
      // half-written entry and no .tmp file is left behind on success.
      renameSync(tmp, file);
    } catch {
      // Best-effort: a failed write just means the next lookup is a miss.
    }
  }

  function has(key: CacheKey): boolean {
    try {
      return existsSync(pathFor(key).file);
    } catch {
      return false;
    }
  }

  return { get, set, has };
}

// make-style stat fastpath for future callers that want to skip work when an
// input file is byte-for-byte unchanged. The core get/set above is fully
// content-hash based and does not depend on this.
export function fileFingerprint(path: string): { size: number; mtimeNs: bigint } | null {
  try {
    const st = statSync(path, { bigint: true });
    return { size: Number(st.size), mtimeNs: st.mtimeNs };
  } catch {
    return null;
  }
}

// Exported for callers/tests that need the raw slot identity.
export { hashKey };
