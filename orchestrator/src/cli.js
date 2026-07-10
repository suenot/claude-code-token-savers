import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { plan } from './planner.js';
import { up } from './supervisor.js';
import { mintToken } from './router-bootstrap.js';
import { runClaude } from './launcher.js';
import { REGISTRY } from './registry.js';

const INSTALL_HINT = {
  pxpipe: 'npm i -g pxpipe-proxy',
  headroom: 'uv tool install headroom-ai',
  router: 'cargo install link-assistant-router  (or: docker pull konard/link-assistant-router)',
};

function version() {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  );
  return pkg.version;
}

function splitClaudeArgs(argv) {
  const i = argv.indexOf('--');
  return i === -1 ? [] : argv.slice(i + 1);
}

function routerRootFromChain(chain) {
  const r = chain.find((s) => s.id === 'router');
  return r ? `http://127.0.0.1:${r.port}` : null;
}

async function doRun(argv) {
  const { config, created } = loadConfig();
  if (created) console.error('shuba: wrote default config to ~/.shuba/chain.json');
  const result = plan(config);
  if (!result.ok) {
    console.error('shuba: invalid chain:\n  - ' + result.errors.join('\n  - '));
    return 1;
  }
  const handle = await up(result.chain);
  try {
    let apiKey;
    if (result.head.requiresToken) {
      apiKey = await mintToken(routerRootFromChain(result.chain));
    }
    console.error('shuba: chain up →', result.chain.map((s) => `${s.id}:${s.port}`).join(' → '));
    const child = runClaude(result.head, { apiKey, claudeArgs: splitClaudeArgs(argv) });
    return await new Promise((resolve) => {
      child.on('exit', async (code) => {
        await handle.down();
        resolve(code ?? 0);
      });
      child.on('error', async (err) => {
        console.error('shuba: failed to launch claude:', err.message);
        await handle.down();
        resolve(1);
      });
    });
  } catch (err) {
    await handle.down();
    throw err;
  }
}

async function doUp() {
  const { config } = loadConfig();
  const result = plan(config);
  if (!result.ok) {
    console.error('shuba: invalid chain:\n  - ' + result.errors.join('\n  - '));
    return 1;
  }
  const handle = await up(result.chain);
  console.error('shuba: chain up:', JSON.stringify(handle.status()));
  console.error('shuba: Ctrl-C to tear down.');
  process.on('SIGINT', async () => {
    await handle.down();
    process.exit(0);
  });
  await new Promise(() => {}); // run until signal
  return 0;
}

function which(bin) {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function doDoctor() {
  for (const id of Object.keys(REGISTRY)) {
    const bin = REGISTRY[id].bin;
    const ok = which(bin);
    console.log(`${ok ? 'ok ' : 'MISSING'}  ${id} (${bin})${ok ? '' : '  → ' + INSTALL_HINT[id]}`);
  }
  const { config } = loadConfig();
  const result = plan(config);
  if (result.ok) {
    console.log('\nplan: ' + result.chain.map((s) => `${s.id}:${s.port}`).join(' → '));
    console.log('head: ' + result.head.baseUrl + (result.head.requiresToken ? '  (router token)' : ''));
  } else {
    console.log('\ninvalid chain:\n  - ' + result.errors.join('\n  - '));
  }
  return 0;
}

export async function cli(argv) {
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
