import { existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

/** Max files under cwd before autobuild refuses to run `extract` automatically. */
export const MAX_AUTOBUILD_FILES = 500;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'graphify-out']);

function countFiles(dir: string): number {
  let count = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return count;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      count += countFiles(join(dir, entry.name));
    } else {
      count += 1;
    }
  }
  return count;
}

export type GraphStatus = {
  built: boolean;
  path: string;
  node_count: number;
  last_built: number | null;
  watching: boolean;
};

export type GraphQueryResult = {
  ok: boolean;
  result: string;
};

export type GraphEnsureResult = {
  action: 'watch' | 'built-then-watch' | 'skipped';
  reason?: string;
};

type ExecFileImpl = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => string;

type SpawnImpl = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcess;

export function createGraph(opts: {
  cwd: string;
  model?: string;
  noMedia?: boolean;
  execFileImpl?: ExecFileImpl;
  spawnImpl?: SpawnImpl;
  watchImpl?: unknown;
  countFilesImpl?: (dir: string) => number;
  now?: () => number;
}): {
  status(): GraphStatus;
  query(q: string, queryOpts?: { model?: string }): GraphQueryResult;
  ensure(ensureOpts?: { autobuild?: boolean }): Promise<GraphEnsureResult>;
  stopWatch(): void;
} {
  const { cwd } = opts;
  const path = join(cwd, 'graphify-out', 'graph.json');
  const model = opts.model ?? 'deepseek/deepseek-v4-flash';

  let watcher: ChildProcess | null = null;

  const execFileImpl: ExecFileImpl =
    opts.execFileImpl ??
    ((file, args, execOpts) =>
      execFileSync(file, args, { cwd: execOpts.cwd, env: execOpts.env }).toString());

  const spawnImpl: SpawnImpl =
    opts.spawnImpl ??
    ((file, args, spawnOpts) => spawn(file, args, { cwd: spawnOpts.cwd, env: spawnOpts.env }));

  const countFilesImpl: (dir: string) => number = opts.countFilesImpl ?? countFiles;

  function status(): GraphStatus {
    const watching = watcher !== null;

    if (!existsSync(path)) {
      return { built: false, path, node_count: 0, last_built: null, watching };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { built: false, path, node_count: 0, last_built: null, watching };
    }

    const obj = parsed as Record<string, unknown>;
    const nodeArr = Array.isArray(obj?.nodes)
      ? obj.nodes
      : Array.isArray(obj?.entities)
        ? obj.entities
        : [];
    const node_count = nodeArr.length;
    const last_built = statSync(path).mtimeMs;

    return { built: true, path, node_count, last_built, watching };
  }

  function query(q: string, queryOpts?: { model?: string }): GraphQueryResult {
    const positionals = q.includes(' -> ')
      ? (() => {
          const [a, b] = q.split(' -> ');
          return [(a ?? '').trim(), (b ?? '').trim()];
        })()
      : [q];

    // Defensive validation against argv flag injection: graphify's CLI parses
    // `explain`/`path` positionals by fixed argv index (not via getopt-style
    // flag scanning) and has no `--` end-of-options support, so a positional
    // starting with '-' cannot actually be reinterpreted as a graphify flag in
    // the current CLI. Still, reject leading-dash positionals defensively in
    // case that parsing ever changes.
    if (positionals.some((p) => p.startsWith('-'))) {
      return { ok: false, result: 'invalid query (leading dash)' };
    }

    const args = positionals.length === 2 ? ['path', ...positionals] : ['explain', ...positionals];
    args.push('--graph', path);

    const model = queryOpts?.model ?? opts.model ?? 'deepseek/deepseek-v4-flash';
    const env = { ...process.env, GRAPHIFY_OPENROUTER_MODEL: model };

    try {
      const result = execFileImpl('graphify', args, { cwd, env });
      return { ok: true, result };
    } catch (err) {
      const message =
        err && typeof err === 'object' && 'stderr' in err && err.stderr
          ? String((err as { stderr: unknown }).stderr)
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, result: message };
    }
  }

  function startWatch(): void {
    // Single-watcher guard: never spawn a second watcher for the same
    // instance while one is already tracked as live.
    if (watcher) return;
    const env = { ...process.env, GRAPHIFY_OPENROUTER_MODEL: model };
    watcher = spawnImpl('graphify', ['watch', cwd], { cwd, env });
  }

  function isAutobuildEnabled(ensureOpts?: { autobuild?: boolean }): boolean {
    if (typeof ensureOpts?.autobuild === 'boolean') return ensureOpts.autobuild;
    return existsSync(join(homedir(), '.shuba', 'autobuild'));
  }

  async function ensure(ensureOpts?: { autobuild?: boolean }): Promise<GraphEnsureResult> {
    if (existsSync(path)) {
      startWatch();
      return { action: 'watch' };
    }

    if (!isAutobuildEnabled(ensureOpts)) {
      return { action: 'skipped', reason: 'not initialized — run graphify build' };
    }

    const fileCount = countFilesImpl(cwd);
    if (fileCount > MAX_AUTOBUILD_FILES) {
      return {
        action: 'skipped',
        reason: `corpus too large (${fileCount} files > ${MAX_AUTOBUILD_FILES}) — build manually`,
      };
    }

    const env: NodeJS.ProcessEnv = { ...process.env, GRAPHIFY_OPENROUTER_MODEL: model };
    if (opts.noMedia) env.GRAPHIFY_NO_MEDIA = '1';
    execFileImpl('graphify', ['extract', cwd, '--backend', 'openrouter'], { cwd, env });
    try {
      execFileImpl('graphify', ['cluster-only', cwd, '--backend', 'openrouter'], { cwd, env });
    } catch {
      // cluster-only failure is non-fatal (mirrors build-and-watch.sh's `|| true`);
      // the graph.json from extract is still usable.
    }

    startWatch();
    return { action: 'built-then-watch' };
  }

  function stopWatch(): void {
    if (!watcher) return;
    watcher.kill('SIGTERM');
    watcher = null;
  }

  return { status, query, ensure, stopWatch };
}
