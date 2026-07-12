import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Capability store: shuba's own home for the skills, agents, MCP servers and
// plugins it has taken over from Claude Code. Rooted at ~/.shuba/capabilities
// (root injectable so tests never touch the real home). The store owns four
// subdirs for the imported payloads plus a manifest.json describing everything
// it holds; the point of the takeover is that once a capability lives here,
// Claude Code's own config no longer lists it, so it stops costing context
// tokens every session.

export type CapabilityType = 'skill' | 'agent' | 'mcp' | 'plugin';

// The manifest entry shape is a cross-module contract (scanner/takeover/http
// and the console all read it) — do NOT add or rename fields here.
export type CapabilityEntry = {
  id: string;
  type: CapabilityType;
  name: string;
  description: string;
  sourcePath: string;
  enabled: boolean;
  importedAt: string;
};

// Reversal metadata is kept OUT of the manifest (whose shape is frozen) in a
// separate reversal.json, so eject() can put each capability back exactly where
// it came from without polluting the public entry shape.
export type ReversalInfo = {
  // skills/agents: where the moved-aside source now lives under backup/.
  backupPath?: string;
  // skills/agents: the original location the backup should be restored to.
  restorePath?: string;
  // mcp: the config file the server key was stripped from, the key, and which
  // nesting it lived under so eject re-inserts it in the same spot.
  mcpConfigPath?: string;
  mcpServerKey?: string;
  mcpLocation?: 'top' | 'project';
  // plugin: the installed_plugins.json we flipped enabled:false in.
  pluginManifestPath?: string;
};

export type CapabilityStore = {
  root: string;
  skillsDir: string;
  agentsDir: string;
  mcpDir: string;
  pluginsDir: string;
  backupDir: string;
  read(): CapabilityEntry[];
  get(id: string): CapabilityEntry | undefined;
  has(id: string): boolean;
  upsert(entry: CapabilityEntry): void;
  remove(id: string): boolean;
  setEnabled(id: string, enabled: boolean): boolean;
  readReversal(id: string): ReversalInfo | undefined;
  writeReversal(id: string, info: ReversalInfo): void;
  clearReversal(id: string): void;
};

// mkdirp / write helpers that create parent dirs on demand — every write in the
// store funnels through these so callers never race an absent directory.
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Never-throw JSON read: a missing or corrupt file yields the fallback rather
// than blowing up a scan/list. Reads across the store all go through this.
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// Move a file or directory, tolerating cross-device renames (EXDEV) by falling
// back to copy+remove. Used for the "move, never delete" backup of sources.
export function movePath(src: string, dest: string): void {
  ensureDir(dirname(dest));
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

export function createCapabilityStore(opts?: { root?: string }): CapabilityStore {
  const root = opts?.root ?? join(homedir(), '.shuba', 'capabilities');
  const skillsDir = join(root, 'skills');
  const agentsDir = join(root, 'agents');
  const mcpDir = join(root, 'mcp');
  const pluginsDir = join(root, 'plugins');
  const backupDir = join(root, 'backup');
  const manifestPath = join(root, 'manifest.json');
  const reversalPath = join(root, 'reversal.json');

  ensureDir(root);

  function read(): CapabilityEntry[] {
    const raw = readJson<unknown>(manifestPath, []);
    return Array.isArray(raw) ? (raw as CapabilityEntry[]) : [];
  }

  function writeAll(entries: CapabilityEntry[]): void {
    writeJson(manifestPath, entries);
  }

  function readReversalMap(): Record<string, ReversalInfo> {
    return readJson<Record<string, ReversalInfo>>(reversalPath, {});
  }

  function writeReversalMap(map: Record<string, ReversalInfo>): void {
    writeJson(reversalPath, map);
  }

  return {
    root,
    skillsDir,
    agentsDir,
    mcpDir,
    pluginsDir,
    backupDir,
    read,
    get(id) {
      return read().find((e) => e.id === id);
    },
    has(id) {
      return read().some((e) => e.id === id);
    },
    upsert(entry) {
      const entries = read();
      const idx = entries.findIndex((e) => e.id === entry.id);
      if (idx === -1) entries.push(entry);
      else entries[idx] = entry;
      writeAll(entries);
    },
    remove(id) {
      const entries = read();
      const next = entries.filter((e) => e.id !== id);
      if (next.length === entries.length) return false;
      writeAll(next);
      return true;
    },
    setEnabled(id, enabled) {
      const entries = read();
      const entry = entries.find((e) => e.id === id);
      if (!entry) return false;
      entry.enabled = enabled;
      writeAll(entries);
      return true;
    },
    readReversal(id) {
      return readReversalMap()[id];
    },
    writeReversal(id, info) {
      const map = readReversalMap();
      map[id] = info;
      writeReversalMap(map);
    },
    clearReversal(id) {
      const map = readReversalMap();
      if (id in map) {
        delete map[id];
        writeReversalMap(map);
      }
    },
  };
}
