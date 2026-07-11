import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcp, unregisterMcp } from '../src/control/mcp-register.ts';

describe('control mcp-register', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shuba-mcp-register-'));
    configPath = join(dir, '.mcp.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('registerMcp creates config with mcpServers.shuba-control when file absent', () => {
    expect(existsSync(configPath)).toBe(false);
    registerMcp(configPath, { command: 'bun', args: ['/abs/path/shuba-control.ts'] });
    const json = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(json).toEqual({
      mcpServers: {
        'shuba-control': { command: 'bun', args: ['/abs/path/shuba-control.ts'] },
      },
    });
  });

  test('registerMcp adds entry, preserving sibling mcpServers and top-level keys', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          someTopLevel: true,
          mcpServers: {
            other: { command: 'foo', args: ['bar'] },
          },
        },
        null,
        2
      )
    );
    registerMcp(configPath, { command: 'bun', args: ['/abs/path/shuba-control.ts'] });
    const json = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(json.someTopLevel).toBe(true);
    expect(json.mcpServers.other).toEqual({ command: 'foo', args: ['bar'] });
    expect(json.mcpServers['shuba-control']).toEqual({
      command: 'bun',
      args: ['/abs/path/shuba-control.ts'],
    });
  });

  test('registerMcp is idempotent: calling twice does not duplicate or change content', () => {
    registerMcp(configPath, { command: 'bun', args: ['/abs/path/shuba-control.ts'] });
    const first = readFileSync(configPath, 'utf8');
    registerMcp(configPath, { command: 'bun', args: ['/abs/path/shuba-control.ts'] });
    const second = readFileSync(configPath, 'utf8');
    expect(second).toBe(first);
    const json = JSON.parse(second);
    expect(Object.keys(json.mcpServers)).toEqual(['shuba-control']);
  });

  test('unregisterMcp removes only shuba-control, leaving siblings and top-level keys intact', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          someTopLevel: true,
          mcpServers: {
            other: { command: 'foo', args: ['bar'] },
            'shuba-control': { command: 'bun', args: ['/abs/path/shuba-control.ts'] },
          },
        },
        null,
        2
      )
    );
    unregisterMcp(configPath);
    const json = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(json.someTopLevel).toBe(true);
    expect(json.mcpServers.other).toEqual({ command: 'foo', args: ['bar'] });
    expect(json.mcpServers['shuba-control']).toBeUndefined();
  });

  test('unregisterMcp is a no-op when file is absent', () => {
    expect(existsSync(configPath)).toBe(false);
    expect(() => unregisterMcp(configPath)).not.toThrow();
    expect(existsSync(configPath)).toBe(false);
  });

  test('unregisterMcp is a no-op when mcpServers is absent', () => {
    writeFileSync(configPath, JSON.stringify({ someTopLevel: true }, null, 2));
    unregisterMcp(configPath);
    const json = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(json).toEqual({ someTopLevel: true });
  });
});
