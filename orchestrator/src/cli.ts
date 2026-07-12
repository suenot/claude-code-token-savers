import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { plan } from './planner.ts';
import { up, stageLogDir } from './supervisor.ts';
import { mintToken } from './router-bootstrap.ts';
import { runClaude } from './launcher.ts';
import { REGISTRY } from './registry.ts';
import { registerMcp, unregisterMcp } from './control/mcp-register.ts';
import { disableClientGraphifyHook } from './control/graphify-hook.ts';
import { detectHarnesses } from './control/harnesses.ts';
import { createGraph } from './control/graph.ts';
import { createTaskManager } from './control/tasks.ts';
import type { PlanResult, PlannedStage, ChainHandle } from './types.ts';
import pkg from '../package.json' with { type: 'json' };

const CONTROL_BIN = fileURLToPath(new URL('../bin/shuba-control.ts', import.meta.url));

// Claude Code MCP config for `shuba run` auto-registration. Defaults to a
// project-level .mcp.json in the launch cwd so the shuba-control server is
// picked up with zero user configuration.
function mcpConfigPath(): string {
  return join(process.cwd(), '.mcp.json');
}

// Claude Code user settings.json, where the client-side graphify SessionStart
// hook (if installed) lives. Factored out as a helper so tests can inject a
// temp path.
function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

const INSTALL_HINT: Record<string, string> = {
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
    // In the compiled binary CONTROL_BIN is a virtual /$bunfs/ path that only
    // this executable can resolve (bin/shuba.ts dispatches it to the embedded
    // module) — registering `bun <bunfs-path>` would write a broken entry.
    // Register the running executable itself as the command instead; in dev
    // process.execPath IS bun, so the entry stays `bun <real-path>` as before.
    registerMcp(mcpConfigPath(), { command: process.execPath, args: [CONTROL_BIN] });
  } catch (err) {
    console.error('shuba: warning: failed to register shuba-control MCP server:', (err as Error).message);
  }
  let restoreGraphifyHook = (): void => {};
  if (config.graph?.enabled !== false) {
    try {
      restoreGraphifyHook = disableClientGraphifyHook(claudeSettingsPath()).restore;
    } catch (err) {
      console.error('shuba: warning: failed to disable client graphify hook:', (err as Error).message);
    }
  }
  try {
    let apiKey;
    if (result.head.requiresToken) {
      apiKey = await mintToken(routerRootFromChain(result.chain) as string);
    }
    console.error(
      'shuba: chain up →',
      result.chain.length
        ? result.chain.map((s) => `${s.id}:${s.port}`).join(' → ')
        : 'passthrough (no stages, direct to api.anthropic.com)',
    );
    console.error(`shuba: stage logs → ${stageLogDir()}/<stage>.log`);
    const controlSidecar = result.sidecars.find((s) => s.id === 'control');
    if (controlSidecar) {
      console.error(`shuba: console → http://127.0.0.1:${controlSidecar.port}/`);
    }
    const child = runClaude(result.head, { apiKey, claudeArgs: splitClaudeArgs(argv) });
    return await new Promise((resolve) => {
      let settled = false;
      const finish = async (code: number | null | undefined) => {
        if (settled) return;
        settled = true;
        try {
          unregisterMcp(mcpConfigPath());
        } catch (err) {
          console.error('shuba: warning: failed to unregister shuba-control MCP server:', (err as Error).message);
        }
        try {
          restoreGraphifyHook();
        } catch (err) {
          console.error('shuba: warning: failed to restore client graphify hook:', (err as Error).message);
        }
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
    try {
      unregisterMcp(mcpConfigPath());
    } catch (unregErr) {
      console.error('shuba: warning: failed to unregister shuba-control MCP server:', (unregErr as Error).message);
    }
    try {
      restoreGraphifyHook();
    } catch (restoreErr) {
      console.error('shuba: warning: failed to restore client graphify hook:', (restoreErr as Error).message);
    }
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

// doTasks prints the top pending shuba tasks (see src/control/tasks.ts),
// same "print top-N pending items" shape as cmdop-claude's `inject-tasks` —
// intended to be wired into a UserPromptSubmit hook so pending work resurfaces
// in every prompt. No-op output (nothing printed) when the queue is empty.
async function doTasks(argv: string[]): Promise<number> {
  const sub = argv[1];
  const tasks = createTaskManager(join(process.cwd(), '.shuba', 'tasks'));

  if (sub === 'list' || sub === undefined) {
    const status = argv[2] as 'pending' | 'completed' | 'dismissed' | undefined;
    console.log(JSON.stringify(tasks.listTasks(status), null, 2));
    return 0;
  }
  if (sub === 'inject') {
    const summary = tasks.getPendingSummary(3);
    if (summary) console.log(summary);
    return 0;
  }
  if (sub === 'complete' || sub === 'dismiss') {
    const id = argv[2];
    if (!id) {
      console.error(`shuba: usage: shuba tasks ${sub} <id>`);
      return 1;
    }
    const status = sub === 'complete' ? 'completed' : 'dismissed';
    const ok = tasks.updateStatus(id, status);
    if (!ok) {
      console.error(`shuba: task "${id}" not found`);
      return 1;
    }
    console.log(`shuba: task ${id} marked ${status}`);
    return 0;
  }
  console.error('shuba: unknown tasks subcommand — list | inject | complete <id> | dismiss <id>');
  return 1;
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
    console.log(
      '\nplan: ' +
        (result.chain.length
          ? result.chain.map((s) => `${s.id}:${s.port}`).join(' → ')
          : 'passthrough (no stages)'),
    );
    console.log('head: ' + result.head.baseUrl + (result.head.requiresToken ? '  (router token)' : ''));
  } else {
    console.log('\ninvalid chain:\n  - ' + result.errors.join('\n  - '));
  }

  const controlEnabled = config.control?.enabled !== false;
  console.log(`\ncontrol: ${controlEnabled ? 'enabled' : 'disabled'} (shuba-control sidecar)`);
  if (controlEnabled && result.ok) {
    const controlSidecar = result.sidecars.find((s) => s.id === 'control');
    if (controlSidecar) {
      console.log(`console: http://127.0.0.1:${controlSidecar.port}/`);
    }
  }
  console.log('harnesses:');
  for (const h of detectHarnesses()) {
    console.log(`  ${h.installed ? 'ok ' : 'MISSING'}  ${h.id} (${h.bin})`);
  }

  try {
    const graphStatus = createGraph({ cwd: process.cwd() }).status();
    console.log(
      `\ngraph: ${graphStatus.built ? 'built' : 'not-initialized'} (${graphStatus.node_count} nodes)`
    );
  } catch {
    console.log('\ngraph: not-initialized (0 nodes)');
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
  if (cmd === 'tasks') return doTasks(argv);
  console.error(`shuba: unknown command "${cmd}" — run | up | status | doctor | down | tasks`);
  return 1;
}
