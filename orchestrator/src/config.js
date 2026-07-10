import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_CONFIG = { terminal: 'anthropic', compressors: ['headroom'], ports: {} };

export function configPath(home = homedir()) {
  return join(home, '.shuba', 'chain.json');
}

export function loadConfig(path = configPath()) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { config: { ...DEFAULT_CONFIG }, created: true };
  }
  return { config: JSON.parse(readFileSync(path, 'utf8')), created: false };
}
