import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from './types.ts';

export const DEFAULT_CONFIG: Config = { terminal: 'anthropic', compressors: ['headroom'], ports: {} };

export function configPath(home: string = homedir()): string {
  return join(home, '.shuba', 'chain.json');
}

export function loadConfig(path: string = configPath()): { config: Config; created: boolean } {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { config: { ...DEFAULT_CONFIG }, created: true };
  }
  return { config: JSON.parse(readFileSync(path, 'utf8')), created: false };
}
