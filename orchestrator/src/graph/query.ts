// Top-level graph query: terms → seeds → context filters → traverse → budgeted
// text. Mirrors graphify serve.py (_query_graph_text) so shuba can answer
// "explain X" / "trace A→B" from a prebuilt graph.json natively.

import type { GraphIndex } from './load.ts';
import { queryTerms, normTerms, computeIdf, pickSeeds } from './idf.ts';
import { bfs, dfs, type TraverseOptions } from './traverse.ts';
import { renderSubgraph } from './render.ts';
import { godNodes } from './god.ts';

export type QueryMode = 'bfs' | 'dfs' | 'auto';

export interface QueryOptions {
  budget?: number;
  depth?: number;
  mode?: QueryMode;
  /** Explicit edge-context filter, e.g. ['call','field']; overrides inference. */
  contextFilter?: string[];
  /** Traversal tuning (e.g. hubThreshold override for tests). */
  traverse?: TraverseOptions;
}

// Question verb → edge-context filter, ported from serve.py _CONTEXT_HINTS.
const CONTEXT_HINTS: Array<[string, string[]]> = [
  ['call', ['call', 'calls', 'called', 'invoke', 'invokes', 'invoked']],
  ['import', ['import', 'imports', 'imported', 'module', 'modules']],
  ['field', ['field', 'fields', 'member', 'members', 'property', 'properties']],
  ['parameter_type', ['parameter', 'parameters', 'param', 'params', 'argument', 'arguments']],
  ['return_type', ['return', 'returns', 'returned']],
  ['generic_arg', ['generic', 'generics', 'template', 'templates']],
];

export function inferContextFilters(question: string): string[] {
  const lowered = new Set(
    question.replace(/[?,]/g, ' ').toLowerCase().split(/\s+/).filter(Boolean),
  );
  const inferred: string[] = [];
  for (const [context, hints] of CONTEXT_HINTS) {
    if (hints.some((h) => lowered.has(h))) inferred.push(context);
  }
  return inferred;
}

/** Pick DFS when the question implies a path/trace, else BFS. */
export function isTraceQuestion(question: string): boolean {
  const q = question.toLowerCase();
  if (/\b(trace|path|reach|reaches|reached|why)\b/.test(q)) return true;
  if (/\bfrom\b.*\bto\b/.test(q)) return true;
  return false;
}

export function queryGraph(index: GraphIndex, question: string, opts: QueryOptions = {}): string {
  const budget = opts.budget ?? 2000;
  const depth = Math.min(opts.depth ?? 3, 6);
  const terms = queryTerms(question);
  const idf = computeIdf(index, normTerms(terms));
  const seeds = pickSeeds(index, terms, idf);
  if (seeds.length === 0) return 'No matching nodes found.';

  const explicit = opts.contextFilter && opts.contextFilter.length ? opts.contextFilter : null;
  const filters = explicit ?? inferContextFilters(question);
  const filterSource = explicit ? 'explicit' : filters.length ? 'heuristic' : null;

  const mode: QueryMode = opts.mode ?? 'auto';
  const useDfs = mode === 'dfs' || (mode === 'auto' && isTraceQuestion(question));
  const traverse = useDfs ? dfs : bfs;
  const { nodes, edges } = traverse(index, seeds, depth, filters, opts.traverse);

  const startLabels = seeds.map((s) => index.nodes.get(s)?.label ?? s);
  const headerParts = [
    `Traversal: ${useDfs ? 'DFS' : 'BFS'} depth=${depth}`,
    `Start: [${startLabels.join(', ')}]`,
  ];
  if (filters.length) headerParts.push(`Context: ${filters.join(', ')} (${filterSource})`);
  headerParts.push(`${nodes.size} nodes found`);
  const header = headerParts.join(' | ') + '\n\n';

  return header + renderSubgraph(index, nodes, seeds, budget, edges);
}

/** God-node orientation summary: node/edge counts + top abstractions by degree. */
export function orientation(index: GraphIndex): string {
  const edgeCount = [...index.degree.values()].reduce((a, b) => a + b, 0) / 2;
  const gods = godNodes(index);
  const lines = [
    `Graph: ${index.nodes.size} nodes, ${edgeCount} edges`,
    'God nodes (core abstractions, most connected):',
  ];
  gods.forEach((node, i) => {
    lines.push(`  ${i + 1}. ${node.label} — ${index.degree.get(node.id) ?? 0} edges`);
  });
  return lines.join('\n');
}
