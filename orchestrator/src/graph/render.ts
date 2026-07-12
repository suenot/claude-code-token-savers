// Budgeted subgraph → text renderer, ported from graphify serve.py
// (_subgraph_to_text). Seed nodes render first, then remaining nodes by degree
// descending. char_budget = tokenBudget * 3; when the output overruns it, we cut
// at the last newline before the cap and append a footer telling the caller how
// many nodes were dropped and how to narrow the query.

import { edgeType, type GraphIndex, type GraphNode } from './load.ts';
import type { TraversedEdge } from './traverse.ts';

function nodeLine(node: GraphNode): string {
  const parts = [
    node.type ? `type=${node.type}` : '',
    node.source_file ? `src=${node.source_file}` : '',
    node.source_location ? `loc=${node.source_location}` : '',
  ].filter(Boolean);
  const meta = parts.length ? ` [${parts.join(' ')}]` : '';
  return `NODE ${node.label}${meta}`;
}

function edgeLine(index: GraphIndex, e: TraversedEdge): string {
  const src = index.nodes.get(e.from);
  const tgt = index.nodes.get(e.to);
  const rel = e.edge.relation ? String(e.edge.relation) : edgeType(e.edge);
  const conf = e.edge.confidence ? String(e.edge.confidence) : '';
  const bracket = conf ? ` [${conf}]` : '';
  return `EDGE ${src?.label ?? e.from} --${rel}${bracket}--> ${tgt?.label ?? e.to}`;
}

/**
 * Render the given node ids (plus edges among them) as budgeted text.
 *
 * @param edges Traversed edges to render. When omitted, all edges induced among
 *   `nodeIds` are reconstructed from adjacency (each emitted once).
 */
export function renderSubgraph(
  index: GraphIndex,
  nodeIds: Set<string> | Iterable<string>,
  seeds: string[],
  tokenBudget: number,
  edges?: TraversedEdge[],
): string {
  const charBudget = tokenBudget * 3;
  const nodeSet = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
  const seedSet = new Set(seeds.filter((s) => nodeSet.has(s)));

  const rest = [...nodeSet]
    .filter((n) => !seedSet.has(n))
    .sort((a, b) => (index.degree.get(b) ?? 0) - (index.degree.get(a) ?? 0));
  const ordered = [...seeds.filter((s) => nodeSet.has(s)), ...rest];

  const lines: string[] = [];
  for (const nid of ordered) {
    const node = index.nodes.get(nid);
    if (node) lines.push(nodeLine(node));
  }

  const edgeList = edges ?? inducedEdges(index, nodeSet);
  for (const e of edgeList) {
    if (nodeSet.has(e.from) && nodeSet.has(e.to)) lines.push(edgeLine(index, e));
  }

  const output = lines.join('\n');
  if (output.length <= charBudget) return output;

  let cutAt = output.slice(0, charBudget).lastIndexOf('\n');
  if (cutAt <= 0) cutAt = charBudget;
  const totalNodes = lines.filter((l) => l.startsWith('NODE ')).length;
  const head = output.slice(0, cutAt);
  const shownNodes = (head.match(/\nNODE /g)?.length ?? 0) + (head.startsWith('NODE ') ? 1 : 0);
  const dropped = totalNodes - shownNodes;
  return (
    head +
    `\n… ${dropped} more nodes cut by ~${tokenBudget}-token budget.` +
    ' Narrow with a more specific term or query a named node.'
  );
}

/** Reconstruct every edge among `nodeSet`, emitting each edge exactly once. */
function inducedEdges(index: GraphIndex, nodeSet: Set<string>): TraversedEdge[] {
  const out: TraversedEdge[] = [];
  for (const nid of nodeSet) {
    for (const entry of index.adjacency.get(nid) ?? []) {
      if (entry.out && nodeSet.has(entry.to)) {
        out.push({ from: nid, to: entry.to, edge: entry.edge });
      }
    }
  }
  return out;
}
