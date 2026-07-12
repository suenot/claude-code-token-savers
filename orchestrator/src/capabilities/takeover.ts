import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createCapabilityStore, movePath, type CapabilityEntry, type CapabilityStore, type ReversalInfo } from './store.ts';
import { scan, type ScannedCapability } from './scanner.ts';

// Takeover: the write half of the capability system. It copies a capability
// into shuba's store, records it in the manifest, then strips it from Claude
// Code so it stops costing context tokens — and can put it all back (eject).
// Every path is explicit so tests run entirely inside temp dirs; nothing here
// runs on its own, only when importOne/importAll/eject is called.

export type VerifyResult = { clean: boolean; leftovers: ScannedCapability[] };

export type CapabilitiesModule = {
  scan(): ScannedCapability[];
  list(): { manifest: CapabilityEntry[]; verify: VerifyResult };
  importOne(id: string): CapabilityEntry | undefined;
  importAll(): CapabilityEntry[];
  eject(id: string): boolean;
  toggle(id: string, enabled: boolean): boolean;
  verify(): VerifyResult;
  store: CapabilityStore;
};

type Deps = {
  store?: CapabilityStore;
  storeRoot?: string;
  claudeRoot?: string;
  projectCwd?: string;
  now?: () => number;
};

// Turn "<name>@<marketplace>" / other id junk into a safe single dir segment.
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Write a `.bak` copy of a file before we rewrite it in place — the mcp/plugin
// config rewrites are the only edits we make to Claude's own files, so keep a
// verbatim pre-edit snapshot alongside.
function backupFile(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function createCapabilities(deps: Deps = {}): CapabilitiesModule {
  const store = deps.store ?? createCapabilityStore({ root: deps.storeRoot });
  const claudeRoot = deps.claudeRoot ?? '~/.claude';
  const projectCwd = deps.projectCwd;
  const now = deps.now ?? (() => Date.now());

  function doScan(): ScannedCapability[] {
    return scan(claudeRoot, projectCwd);
  }

  function timestamp(): string {
    return String(now());
  }

  // --- per-type import: copy into store, then strip from Claude ---

  function importSkill(item: ScannedCapability): ReversalInfo {
    const name = item.name;
    cpSync(item.sourcePath, join(store.skillsDir, name), { recursive: true });
    const backupPath = join(store.backupDir, timestamp(), 'skills', name);
    movePath(item.sourcePath, backupPath);
    return { backupPath, restorePath: item.sourcePath };
  }

  function importAgent(item: ScannedCapability): ReversalInfo {
    const file = basename(item.sourcePath);
    cpSync(item.sourcePath, join(store.agentsDir, file));
    const backupPath = join(store.backupDir, timestamp(), 'agents', file);
    movePath(item.sourcePath, backupPath);
    return { backupPath, restorePath: item.sourcePath };
  }

  function importMcp(item: ScannedCapability): ReversalInfo {
    const mcp = item.mcp!;
    // Copy the server config object into our own store.
    writeJsonFile(join(store.mcpDir, `${safeSegment(mcp.serverKey)}.json`), mcp.config);
    // Rewrite the source file, dropping just this server key (backup first).
    backupFile(mcp.configPath);
    const doc = readJsonFile<Record<string, any>>(mcp.configPath, {});
    let location: 'top' | 'project' = 'top';
    if (doc.mcpServers && typeof doc.mcpServers === 'object' && mcp.serverKey in doc.mcpServers) {
      delete doc.mcpServers[mcp.serverKey];
      location = 'top';
    }
    if (projectCwd && doc.projects?.[projectCwd]?.mcpServers && mcp.serverKey in doc.projects[projectCwd].mcpServers) {
      delete doc.projects[projectCwd].mcpServers[mcp.serverKey];
      location = 'project';
    }
    writeJsonFile(mcp.configPath, doc);
    return { mcpConfigPath: mcp.configPath, mcpServerKey: mcp.serverKey, mcpLocation: location };
  }

  function importPlugin(item: ScannedCapability): ReversalInfo {
    const plugin = item.plugin!;
    const destDir = join(store.pluginsDir, safeSegment(item.id));
    // Copy the plugin's cached skill/agent files into the store so we own a
    // copy even after Claude eventually prunes its cache.
    for (const file of plugin.cachedFiles) {
      if (existsSync(file)) cpSync(file, join(destDir, 'files', basename(file)));
    }
    // Disable (don't uninstall) the plugin in installed_plugins.json — safer,
    // and reversible by just clearing the flag. Backup the manifest first.
    backupFile(plugin.manifestPath);
    const doc = readJsonFile<{ plugins?: Record<string, Array<Record<string, unknown>>> }>(plugin.manifestPath, {});
    const pluginKey = item.id.slice('plugin:'.length);
    const records = doc.plugins?.[pluginKey];
    if (Array.isArray(records)) {
      for (const rec of records) rec.enabled = false;
      writeJsonFile(plugin.manifestPath, doc);
    }
    return { pluginManifestPath: plugin.manifestPath };
  }

  function importItem(item: ScannedCapability): CapabilityEntry {
    let reversal: ReversalInfo;
    switch (item.type) {
      case 'skill':
        reversal = importSkill(item);
        break;
      case 'agent':
        reversal = importAgent(item);
        break;
      case 'mcp':
        reversal = importMcp(item);
        break;
      case 'plugin':
        reversal = importPlugin(item);
        break;
    }
    const entry: CapabilityEntry = {
      id: item.id,
      type: item.type,
      name: item.name,
      description: item.description,
      sourcePath: item.sourcePath,
      enabled: true,
      importedAt: new Date(now()).toISOString(),
    };
    store.upsert(entry);
    store.writeReversal(item.id, reversal);
    return entry;
  }

  function importOne(id: string): CapabilityEntry | undefined {
    // Idempotent: importing an already-imported id is a no-op.
    if (store.has(id)) return store.get(id);
    const item = doScan().find((c) => c.id === id);
    if (!item) return undefined;
    return importItem(item);
  }

  function importAll(): CapabilityEntry[] {
    const out: CapabilityEntry[] = [];
    for (const item of doScan()) {
      if (store.has(item.id)) continue;
      out.push(importItem(item));
    }
    return out;
  }

  // --- eject: put a capability back into Claude Code ---

  function eject(id: string): boolean {
    const entry = store.get(id);
    if (!entry) return false;
    const reversal = store.readReversal(id) ?? {};

    if (entry.type === 'skill' || entry.type === 'agent') {
      if (reversal.backupPath && reversal.restorePath && existsSync(reversal.backupPath)) {
        movePath(reversal.backupPath, reversal.restorePath);
      }
      rmSync(join(entry.type === 'skill' ? store.skillsDir : store.agentsDir, entry.type === 'skill' ? entry.name : basename(entry.sourcePath)), {
        recursive: true,
        force: true,
      });
    } else if (entry.type === 'mcp') {
      // Re-insert the stored config object at the exact location we removed it.
      const serverKey = reversal.mcpServerKey ?? id.slice('mcp:'.length);
      const configPath = reversal.mcpConfigPath ?? entry.sourcePath;
      const stored = readJsonFile<unknown>(join(store.mcpDir, `${safeSegment(serverKey)}.json`), undefined);
      const doc = readJsonFile<Record<string, any>>(configPath, {});
      if (reversal.mcpLocation === 'project' && projectCwd) {
        doc.projects = doc.projects ?? {};
        doc.projects[projectCwd] = doc.projects[projectCwd] ?? {};
        doc.projects[projectCwd].mcpServers = doc.projects[projectCwd].mcpServers ?? {};
        doc.projects[projectCwd].mcpServers[serverKey] = stored;
      } else {
        doc.mcpServers = doc.mcpServers ?? {};
        doc.mcpServers[serverKey] = stored;
      }
      writeJsonFile(configPath, doc);
      rmSync(join(store.mcpDir, `${safeSegment(serverKey)}.json`), { force: true });
    } else if (entry.type === 'plugin') {
      // Re-enable in installed_plugins.json (clear the enabled:false flag).
      const manifestPath = reversal.pluginManifestPath;
      if (manifestPath && existsSync(manifestPath)) {
        const doc = readJsonFile<{ plugins?: Record<string, Array<Record<string, unknown>>> }>(manifestPath, {});
        const pluginKey = id.slice('plugin:'.length);
        const records = doc.plugins?.[pluginKey];
        if (Array.isArray(records)) {
          for (const rec of records) delete rec.enabled;
          writeJsonFile(manifestPath, doc);
        }
      }
      rmSync(join(store.pluginsDir, safeSegment(id)), { recursive: true, force: true });
    }

    store.remove(id);
    store.clearReversal(id);
    return true;
  }

  function toggle(id: string, enabled: boolean): boolean {
    return store.setEnabled(id, enabled);
  }

  function verify(): VerifyResult {
    // Re-scan Claude Code; anything still detectable that we already imported
    // means the strip didn't fully take — those are the leftovers the user's
    // "is Claude Code empty" check flags.
    const imported = new Set(store.read().map((e) => e.id));
    const leftovers = doScan().filter((c) => imported.has(c.id));
    return { clean: leftovers.length === 0, leftovers };
  }

  return {
    scan: doScan,
    list() {
      return { manifest: store.read(), verify: verify() };
    },
    importOne,
    importAll,
    eject,
    toggle,
    verify,
    store,
  };
}
