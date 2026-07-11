import { execSync } from 'node:child_process';
import { loadConfig } from './config.ts';
import { plan } from './planner.ts';
import { up } from './supervisor.ts';
import { mintToken } from './router-bootstrap.ts';
import { runClaude } from './launcher.ts';
import { REGISTRY } from './registry.ts';
import type { PlanResult, PlannedStage, ChainHandle } from './types.ts';
import pkg from '../package.json' with { type: 'json' };

const INSTALL_HINT: Record<string, string> = {
  pxpipe: 'npm i -g pxpipe-proxy',
  headroom: 'uv tool install "headroom-ai[proxy]"',
  router: 'cargo install link-assistant-router  (or: docker pull konard/link-assistant-router — repo: https://github.com/link-assistant/router)',
};

function version(): string {
  return pkg.version;
}

export function splitClaudeArgs(argv: string[]): string[] {
  // Everything after `run` is forwarded to claude (a leading `--` separator is
  // dropped if present). `--dangerously-skip-permissions` is always applied so a
  // shuba-launched claude never stops for permission prompts; deduped if the user
  // also passed it. This lets `shuba run --resume`, `shuba run -- --resume`, etc.
  let rest = argv.slice(1); // drop the `run` command itself
  if (rest[0] === '--') rest = rest.slice(1);
  // On by default (power-user auto mode), but opt out with SHUBA_SKIP_PERMISSIONS=0
  // — it makes claude run every tool call without a permission prompt, so only
  // keep it on for sessions whose work you trust.
  const skip = process.env.SHUBA_SKIP_PERMISSIONS !== '0';
  const args = skip ? ['--dangerously-skip-permissions', ...rest] : [...rest];
  return args.filter((a, i) => args.indexOf(a) === i);
}

function routerRootFromChain(chain: PlannedStage[]): string | null {
  const r = chain.find((s) => s.id === 'router');
  return r ? `http://127.0.0.1:${r.port}` : null;
}

async function doRun(argv: string[]): Promise<number> {
  const { config, created } = loadConfig();
  if (created) console.error('shuba: wrote default config to ~/.shuba/chain.json');
  const result: PlanResult = plan(config);
  if (!result.ok) {
    console.error('shuba: invalid chain:\n  - ' + result.errors.join('\n  - '));
    return 1;
  }
  const handle: ChainHandle = await up(result.chain, { sidecars: result.sidecars });
  try {
    let apiKey;
    if (result.head.requiresToken) {
      apiKey = await mintToken(routerRootFromChain(result.chain) as string);
    }
    console.error('shuba: chain up →', result.chain.map((s) => `${s.id}:${s.port}`).join(' → '));
    const child = runClaude(result.head, { apiKey, claudeArgs: splitClaudeArgs(argv) });
    return await new Promise((resolve) => {
      let settled = false;
      const finish = async (code: number | null | undefined) => {
        if (settled) return;
        settled = true;
        await handle.down();
        resolve(code ?? 0);
      };
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => finish(0));
      }
      child.on('exit', (code) => finish(code));
      child.on('error', (err) => {
        console.error('shuba: failed to launch claude:', err.message);
        finish(1);
      });
    });
  } catch (err) {
    await handle.down();
    throw err;
  }
}

async function doUp(): Promise<number> {
  const { config } = loadConfig();
  const result: PlanResult = plan(config);
  if (!result.ok) {
    console.error('shuba: invalid chain:\n  - ' + result.errors.join('\n  - '));
    return 1;
  }
  const handle: ChainHandle = await up(result.chain, { sidecars: result.sidecars });
  console.error('shuba: chain up:', JSON.stringify(handle.status()));
  console.error('shuba: Ctrl-C to tear down.');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await handle.down();
      process.exit(0);
    });
  }
  await new Promise(() => {}); // run until signal
  return 0;
}

function which(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function doDoctor(): Promise<number> {
  for (const id of Object.keys(REGISTRY)) {
    const bin = REGISTRY[id].bin;
    const ok = which(bin);
    console.log(`${ok ? 'ok ' : 'MISSING'}  ${id} (${bin})${ok ? '' : '  → ' + INSTALL_HINT[id]}`);
  }
  const { config } = loadConfig();
  const result: PlanResult = plan(config);
  if (result.ok) {
    console.log('\nplan: ' + result.chain.map((s) => `${s.id}:${s.port}`).join(' → '));
    console.log('head: ' + result.head.baseUrl + (result.head.requiresToken ? '  (router token)' : ''));
  } else {
    console.log('\ninvalid chain:\n  - ' + result.errors.join('\n  - '));
  }
  return 0;
}

export async function cli(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === '--version' || cmd === '-v') {
    console.log(version());
    return 0;
  }
  if (cmd === 'run' || cmd === undefined) return doRun(argv);
  if (cmd === 'up') return doUp();
  if (cmd === 'status') return doDoctor();
  if (cmd === 'doctor') return doDoctor();
  if (cmd === 'down') {
    console.log('shuba: v1 keeps the chain tied to the foreground `run`/`up` process; stop that process to tear down.');
    return 0;
  }
  console.error(`shuba: unknown command "${cmd}" — run | up | status | doctor | down`);
  return 1;
}
