import { spawn, type ChildProcess } from 'node:child_process';

export interface RunClaudeHead {
  baseUrl: string;
  requiresToken?: boolean;
}

export interface RunClaudeOpts {
  apiKey?: string;
  claudeArgs?: string[];
  spawnImpl?: typeof spawn;
}

export function runClaude(head: RunClaudeHead, { apiKey, claudeArgs = [], spawnImpl = spawn }: RunClaudeOpts = {}): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_BASE_URL: head.baseUrl };
  if (head.requiresToken) {
    if (!apiKey) throw new Error('chain requires a router token but none was provided');
    env.ANTHROPIC_API_KEY = apiKey;
  }
  return spawnImpl('claude', claudeArgs, { env, stdio: 'inherit' });
}
