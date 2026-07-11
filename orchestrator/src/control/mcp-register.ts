import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface McpServerEntry {
  command: string;
  args: string[];
}

const SHUBA_CONTROL_KEY = 'shuba-control';

function readJson(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, 'utf8').trim();
  if (raw === '') return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeJson(configPath: string, data: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Idempotently registers the shuba-control MCP server into a Claude Code
 * MCP config file (e.g. project `.mcp.json`). Creates the file (and the
 * `mcpServers` object) if absent. Preserves all other keys/entries. Only
 * writes if the entry differs from what's already there, so repeated calls
 * don't churn the file or its mtime.
 */
export function registerMcp(configPath: string, entry: McpServerEntry): void {
  const data = readJson(configPath);
  const mcpServers = (data.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (deepEqual(mcpServers[SHUBA_CONTROL_KEY], entry)) return;
  data.mcpServers = { ...mcpServers, [SHUBA_CONTROL_KEY]: entry };
  writeJson(configPath, data);
}

/**
 * Removes the shuba-control MCP server entry from the config, leaving all
 * other keys and sibling mcpServers entries intact. No-op if the file or
 * the entry doesn't exist.
 */
export function unregisterMcp(configPath: string): void {
  if (!existsSync(configPath)) return;
  const data = readJson(configPath);
  const mcpServers = data.mcpServers as Record<string, unknown> | undefined;
  if (!mcpServers || !(SHUBA_CONTROL_KEY in mcpServers)) return;
  const { [SHUBA_CONTROL_KEY]: _removed, ...rest } = mcpServers;
  data.mcpServers = rest;
  writeJson(configPath, data);
}
