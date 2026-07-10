import { spawn } from 'node:child_process';

export function runClaude(head, { apiKey, claudeArgs = [], spawnImpl = spawn } = {}) {
  const env = { ...process.env, ANTHROPIC_BASE_URL: head.baseUrl };
  if (head.requiresToken) {
    if (!apiKey) throw new Error('chain requires a router token but none was provided');
    env.ANTHROPIC_API_KEY = apiKey;
  }
  return spawnImpl('claude', claudeArgs, { env, stdio: 'inherit' });
}
