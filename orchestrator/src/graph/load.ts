// Native graph loader: turns a graphify graph.json into an in-memory index
// (nodes + undirected adjacency + total degree). Tolerant of the field-name
// variations graphify emits (`nodes`|`entities`, `source`/`target`|`from`/`to`,
// edges under `edges`|`links`) so a prebuilt graph.json can be queried without
// shelling out to the Python CLI.

export interface GraphNode {
  id: string;
  label: string;
  /** Coarse node kind (file|function|class|concept|…) when the graph provides one. */
  type?: string;
  source_file?: string;
  source_location?: string;
  norm_label?: string;
  file_type?: string;
  community?: string | number;
  community_name?: string;
  [key: string]: unknown;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Edge context/kind (call|import|contains|return_type|…). */
  type?: string;
  relation?: string;
  confidence?: string;
  context?: string;
  [key: string]: unknown;
}

/** One end of an edge as seen from a node, precomputed for O(1) neighbour walks. */
export interface AdjEntry {
  /** Neighbour node id. */
  to: string;
  /** The originating edge (shared object; appears in both endpoints' lists). */
  edge: GraphEdge;
  /** True on the endpoint that is `edge.source` — used to emit each edge once. */
  out: boolean;
}

export interface GraphIndex {
  nodes: Map<string, GraphNode>;
  /** Undirected adjacency: every edge is listed under both endpoints. */
  adjacency: Map<string, AdjEntry[]>;
  /** Total (in+out) degree per node, matching networkx DiGraph.degree. */
  degree: Map<string, number>;
}

/** Read the edge's context/kind, tolerating graphify's field aliases. */
export function edgeType(edge: GraphEdge): string {
  return String(edge.type ?? edge.context ?? edge.relation ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function nodeArray(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root.nodes)) return root.nodes;
  if (Array.isArray(root.entities)) return root.entities;
  return [];
}

function edgeArray(root: Record<string, unknown>): unknown[] {
  if (Array.isArray(root.edges)) return root.edges;
  if (Array.isArray(root.links)) return root.links;
  return [];
}

export function loadGraph(json: unknown): GraphIndex {
  const root = asRecord(json);
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, AdjEntry[]>();
  const degree = new Map<string, number>();

  for (const raw of nodeArray(root)) {
    const rec = asRecord(raw);
    const id = rec.id != null ? String(rec.id) : rec.label != null ? String(rec.label) : '';
    if (!id || nodes.has(id)) continue;
    const label = rec.label != null ? String(rec.label) : id;
    nodes.set(id, { ...(rec as GraphNode), id, label });
    adjacency.set(id, []);
    degree.set(id, 0);
  }

  const ensure = (id: string): void => {
    if (nodes.has(id)) return;
    // Edge references a node not declared in the node list — materialize a stub
    // so traversal/degree stay consistent rather than silently dropping the edge.
    nodes.set(id, { id, label: id });
    adjacency.set(id, []);
    degree.set(id, 0);
  };

  for (const raw of edgeArray(root)) {
    const rec = asRecord(raw);
    const source = rec.source != null ? String(rec.source) : rec.from != null ? String(rec.from) : '';
    const target = rec.target != null ? String(rec.target) : rec.to != null ? String(rec.to) : '';
    if (!source || !target) continue;
    ensure(source);
    ensure(target);
    const edge: GraphEdge = { ...(rec as GraphEdge), source, target };
    adjacency.get(source)!.push({ to: target, edge, out: true });
    adjacency.get(target)!.push({ to: source, edge, out: false });
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
  }

  return { nodes, adjacency, degree };
}
