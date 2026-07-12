import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { CapabilityType } from './store.ts';

// Scanner: a pure, read-only sweep of everywhere Claude Code keeps a capability
// that costs context tokens — skills, agents, MCP servers, plugins. It never
// writes; takeover.ts consumes this list to import + strip. Every returned item
// carries a stable id (used across scan → import → verify) and a sourcePath so
// the importer knows exactly what to move.

export type ScannedCapability = {
  id: string;
  type: CapabilityType;
  name: string;
  description: string;
  sourcePath: string;
  // mcp only: the server config object, the file it lives in, and its key —
  // enough for takeover to copy it out and rewrite the source JSON.
  mcp?: { config: unknown; configPath: string; serverKey: string };
  // plugin only: the plugin manifest we'd flip enabled:false in, plus the
  // cached skill/agent files that ship with the plugin (attributed to it).
  plugin?: { manifestPath: string; cachedFiles: string[] };
};

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

// Extract `name:`/`description:` from a leading `--- ... ---` YAML frontmatter
// block. Deliberately minimal (no YAML dep): frontmatter here is always flat
// `key: value` scalars. Returns empty strings when absent so callers can fall
// back to a filename.
function parseFrontmatter(raw: string): { name: string; description: string } {
  const out = { name: '', description: '' };
  if (!raw.startsWith('---')) return out;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return out;
  const block = raw.slice(3, end);
  for (const line of block.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'name' && !out.name) out.name = value;
    else if (key === 'description' && !out.description) out.description = value;
  }
  return out;
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(ext))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

// skills: <claudeRoot>/skills/<name>/SKILL.md
function scanSkills(claudeRoot: string): ScannedCapability[] {
  const out: ScannedCapability[] = [];
  for (const skillDir of listDirs(join(claudeRoot, 'skills'))) {
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const fm = parseFrontmatter(readFileSafe(skillMd));
    const name = fm.name || basename(skillDir);
    out.push({
      id: `skill:${name}`,
      type: 'skill',
      name,
      description: fm.description,
      sourcePath: skillDir,
    });
  }
  return out;
}

// agents: <claudeRoot>/agents/*.md and <projectCwd>/.claude/agents/*.md
function scanAgents(claudeRoot: string, projectCwd?: string): ScannedCapability[] {
  const out: ScannedCapability[] = [];
  const dirs = [join(claudeRoot, 'agents')];
  if (projectCwd) dirs.push(join(projectCwd, '.claude', 'agents'));
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const file of listFiles(dir, '.md')) {
      const fm = parseFrontmatter(readFileSafe(file));
      const name = fm.name || basename(file, '.md');
      const id = `agent:${name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, type: 'agent', name, description: fm.description, sourcePath: file });
    }
  }
  return out;
}

// mcp: parse mcpServers objects out of the project .mcp.json, the per-project
// entry in ~/.claude.json (projects[cwd].mcpServers), and the top-level
// ~/.claude.json mcpServers. Read-only, tolerant of every file being absent.
function readMcpServers(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSafe(path)) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    return servers && typeof servers === 'object' ? (servers as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function scanMcp(claudeRoot: string, projectCwd?: string): ScannedCapability[] {
  const out: ScannedCapability[] = [];
  const seen = new Set<string>();
  // ~/.claude.json sits next to (one level up from) ~/.claude.
  const claudeJson = join(claudeRoot, '..', '.claude.json');

  const sources: Array<{ path: string; servers: Record<string, unknown> }> = [];
  if (projectCwd) {
    sources.push({ path: join(projectCwd, '.mcp.json'), servers: readMcpServers(join(projectCwd, '.mcp.json')) });
  }
  // projects[cwd].mcpServers lives inside ~/.claude.json.
  if (projectCwd && existsSync(claudeJson)) {
    try {
      const parsed = JSON.parse(readFileSafe(claudeJson)) as { projects?: Record<string, { mcpServers?: unknown }> };
      const proj = parsed?.projects?.[projectCwd];
      const servers = proj?.mcpServers;
      if (servers && typeof servers === 'object') {
        sources.push({ path: claudeJson, servers: servers as Record<string, unknown> });
      }
    } catch {
      // tolerate malformed ~/.claude.json
    }
  }
  // top-level ~/.claude.json mcpServers
  sources.push({ path: claudeJson, servers: readMcpServers(claudeJson) });

  for (const { path, servers } of sources) {
    for (const [serverKey, config] of Object.entries(servers)) {
      const id = `mcp:${serverKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        type: 'mcp',
        name: serverKey,
        description: '',
        sourcePath: path,
        mcp: { config, configPath: path, serverKey },
      });
    }
  }
  return out;
}

// Collect the skill/agent markdown files a plugin ships (SKILL.md files under
// skills/, *.md under agents/), rooted at the plugin's install dir in the cache.
function collectPluginFiles(installPath: string): string[] {
  const files: string[] = [];
  for (const skillDir of listDirs(join(installPath, 'skills'))) {
    const skillMd = join(skillDir, 'SKILL.md');
    if (existsSync(skillMd)) files.push(skillMd);
  }
  files.push(...listFiles(join(installPath, 'agents'), '.md'));
  return files;
}

// plugins: <claudeRoot>/plugins/installed_plugins.json (v2 shape:
// { plugins: { "<id>": [ { installPath, ... } ] } }). Each plugin becomes one
// capability whose cached skill/agent files are attributed to it.
function scanPlugins(claudeRoot: string): ScannedCapability[] {
  const manifestPath = join(claudeRoot, 'plugins', 'installed_plugins.json');
  if (!existsSync(manifestPath)) return [];
  let parsed: { plugins?: Record<string, Array<{ installPath?: string; enabled?: boolean }>> };
  try {
    parsed = JSON.parse(readFileSafe(manifestPath));
  } catch {
    return [];
  }
  const out: ScannedCapability[] = [];
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== 'object') return [];
  for (const [pluginId, installs] of Object.entries(plugins)) {
    const records = Array.isArray(installs) ? installs : [];
    // A plugin shuba has already taken over is flipped enabled:false in place
    // (rather than uninstalled). Those no longer cost Claude context, so they
    // are not "still living in Claude Code" — skip them.
    if (records.length > 0 && records.every((r) => r?.enabled === false)) continue;
    const installPath = records.find((i) => typeof i?.installPath === 'string')?.installPath;
    // Plugin id is "<name>@<marketplace>"; the bare name reads best.
    const name = pluginId.split('@')[0] ?? pluginId;
    const cachedFiles = installPath ? collectPluginFiles(installPath) : [];
    out.push({
      id: `plugin:${pluginId}`,
      type: 'plugin',
      name,
      description: '',
      sourcePath: installPath ?? manifestPath,
      plugin: { manifestPath, cachedFiles },
    });
  }
  return out;
}

// scan finds every capability still living in Claude Code. Pure read: nothing
// here mutates the filesystem.
export function scan(claudeRoot = '~/.claude', projectCwd?: string): ScannedCapability[] {
  const root = expandHome(claudeRoot);
  return [
    ...scanSkills(root),
    ...scanAgents(root, projectCwd),
    ...scanMcp(root, projectCwd),
    ...scanPlugins(root),
  ];
}
