import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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

type ExecFileImpl = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => string;

export function createGraph(opts: {
  cwd: string;
  model?: string;
  execFileImpl?: ExecFileImpl;
  watchImpl?: unknown;
  now?: () => number;
}): {
  status(): GraphStatus;
  query(q: string, queryOpts?: { model?: string }): GraphQueryResult;
} {
  const { cwd } = opts;
  const path = join(cwd, 'graphify-out', 'graph.json');

  const execFileImpl: ExecFileImpl =
    opts.execFileImpl ??
    ((file, args, execOpts) =>
      execFileSync(file, args, { cwd: execOpts.cwd, env: execOpts.env }).toString());

  function status(): GraphStatus {
    if (!existsSync(path)) {
      return { built: false, path, node_count: 0, last_built: null, watching: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { built: false, path, node_count: 0, last_built: null, watching: false };
    }

    const obj = parsed as Record<string, unknown>;
    const nodeArr = Array.isArray(obj?.nodes)
      ? obj.nodes
      : Array.isArray(obj?.entities)
        ? obj.entities
        : [];
    const node_count = nodeArr.length;
    const last_built = statSync(path).mtimeMs;

    return { built: true, path, node_count, last_built, watching: false };
  }

  function query(q: string, queryOpts?: { model?: string }): GraphQueryResult {
    const args = q.includes(' -> ')
      ? (() => {
          const [a, b] = q.split(' -> ');
          return ['path', (a ?? '').trim(), (b ?? '').trim()];
        })()
      : ['explain', q];
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

  return { status, query };
}
