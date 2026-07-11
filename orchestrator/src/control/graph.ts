import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type GraphStatus = {
  built: boolean;
  path: string;
  node_count: number;
  last_built: number | null;
  watching: boolean;
};

export function createGraph(opts: {
  cwd: string;
  model?: string;
  execFileImpl?: unknown;
  watchImpl?: unknown;
  now?: () => number;
}): {
  status(): GraphStatus;
} {
  const { cwd } = opts;
  const path = join(cwd, 'graphify-out', 'graph.json');

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

  return { status };
}
