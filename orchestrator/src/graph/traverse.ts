// BFS/DFS traversal with hub-gating, ported from graphify serve.py (_bfs/_dfs).
// Hub nodes (degree >= threshold) are visited but not expanded through — except
// when they are seeds — so a single mega-connected node can't blow up the
// subgraph. BFS gives broad context; DFS traces a specific path.

import { edgeType, type GraphIndex, type GraphEdge } from './load.ts';

export interface TraversedEdge {
  from: string;
  to: string;
  edge: GraphEdge;
}

export interface TraversalResult {
  nodes: Set<string>;
  edges: TraversedEdge[];
}

export interface TraverseOptions {
  /** Override the computed hub threshold (mainly for tests). */
  hubThreshold?: number;
}

/** Hub threshold: p99 of the degree distribution, floored at 50. */
export function computeHubThreshold(index: GraphIndex): number {
  const degrees = [...index.degree.values()];
  if (degrees.length === 0) return 50;
  degrees.sort((a, b) => a - b);
  const idx = Math.min(Math.floor(degrees.length * 0.99), degrees.length - 1);
  return Math.max(50, degrees[idx]!);
}

function neighbors(index: GraphIndex, node: string, edgeFilter?: string[]): TraversedEdge[] {
  const out: TraversedEdge[] = [];
  const filter = edgeFilter && edgeFilter.length ? new Set(edgeFilter) : null;
  for (const entry of index.adjacency.get(node) ?? []) {
    if (filter && !filter.has(edgeType(entry.edge))) continue;
    out.push({ from: node, to: entry.to, edge: entry.edge });
  }
  return out;
}

export function bfs(
  index: GraphIndex,
  seeds: string[],
  depth: number,
  edgeFilter?: string[],
  opts: TraverseOptions = {},
): TraversalResult {
  const hubThreshold = opts.hubThreshold ?? computeHubThreshold(index);
  const seedSet = new Set(seeds);
  const visited = new Set(seeds);
  const edges: TraversedEdge[] = [];
  let frontier = new Set(seeds);

  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const n of frontier) {
      // Don't expand through high-degree hubs (seeds are always expanded).
      if (!seedSet.has(n) && (index.degree.get(n) ?? 0) >= hubThreshold) continue;
      for (const nb of neighbors(index, n, edgeFilter)) {
        if (!visited.has(nb.to)) {
          next.add(nb.to);
          edges.push(nb);
        }
      }
    }
    for (const n of next) visited.add(n);
    frontier = next;
  }
  return { nodes: visited, edges };
}

export function dfs(
  index: GraphIndex,
  seeds: string[],
  depth: number,
  edgeFilter?: string[],
  opts: TraverseOptions = {},
): TraversalResult {
  const hubThreshold = opts.hubThreshold ?? computeHubThreshold(index);
  const seedSet = new Set(seeds);
  const visited = new Set<string>();
  const edges: TraversedEdge[] = [];
  const stack: Array<{ node: string; d: number }> = [...seeds].reverse().map((n) => ({ node: n, d: 0 }));

  while (stack.length) {
    const { node, d } = stack.pop()!;
    if (visited.has(node) || d > depth) continue;
    visited.add(node);
    if (!seedSet.has(node) && (index.degree.get(node) ?? 0) >= hubThreshold) continue;
    for (const nb of neighbors(index, node, edgeFilter)) {
      if (!visited.has(nb.to)) {
        stack.push({ node: nb.to, d: d + 1 });
        edges.push(nb);
      }
    }
  }
  return { nodes: visited, edges };
}
