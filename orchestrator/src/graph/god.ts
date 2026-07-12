// God nodes: the most-connected real entities, ported from graphify analyze.py
// (god_nodes). File-level hubs, concept nodes, JSON-key noise, and builtin/mock
// labels are excluded so the result reflects meaningful architectural
// abstractions rather than mechanical import/contains hubs.

import type { GraphIndex, GraphNode } from './load.ts';

const BUILTIN_NOISE_LABELS = new Set([
  'str', 'int', 'float', 'bool', 'bytes', 'bytearray', 'complex', 'object',
  'True', 'False',
  'MagicMock', 'Mock', 'AsyncMock', 'NonCallableMock',
  'NonCallableMagicMock', 'PropertyMock', 'patch', 'sentinel',
  'Path', 'Any', 'Optional', 'List', 'Dict', 'Set', 'Tuple', 'Union',
  'Callable', 'Type', 'ClassVar', 'Final', 'Literal', 'Protocol',
  'Counter', 'defaultdict', 'OrderedDict', 'datetime', 'Enum',
  'os', 'sys', 're', 'json', 'io', 'abc', 'typing',
]);

const JSON_NOISE_LABELS = new Set([
  'start', 'end', 'name', 'id', 'type', 'properties',
  'value', 'key', 'data', 'items', 'title', 'description', 'version',
  'dependencies', 'devdependencies', 'peerdependencies',
  'optionaldependencies', 'bundleddependencies', 'bundledependencies',
]);

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function isFileNode(index: GraphIndex, node: GraphNode): boolean {
  if (node.type === 'file') return true;
  const label = node.label ?? '';
  if (!label) return false;
  const source = node.source_file ?? '';
  if (source && label === basename(source)) return true;
  if (label.startsWith('.') && label.endsWith('()')) return true;
  if (label.endsWith('()') && (index.degree.get(node.id) ?? 0) <= 1) return true;
  return false;
}

function isConceptNode(node: GraphNode): boolean {
  if (node.type === 'concept') return true;
  const source = String(node.source_file ?? '');
  if (!source) return true;
  // No file extension on the basename → a concept label, not a real file.
  if (!basename(source).includes('.')) return true;
  return false;
}

function isJsonKeyNode(node: GraphNode): boolean {
  if (node.type === 'json-key' || node.type === 'json_key') return true;
  const source = String(node.source_file ?? '').toLowerCase();
  if (!source.endsWith('.json')) return false;
  return JSON_NOISE_LABELS.has(String(node.label ?? '').trim().toLowerCase());
}

/** Top-`n` most-connected real entities, excluding file/concept/json-key/noise. */
export function godNodes(index: GraphIndex, n = 15): GraphNode[] {
  const sorted = [...index.nodes.values()].sort(
    (a, b) => (index.degree.get(b.id) ?? 0) - (index.degree.get(a.id) ?? 0),
  );
  const result: GraphNode[] = [];
  for (const node of sorted) {
    if (isFileNode(index, node) || isConceptNode(node) || isJsonKeyNode(node)) continue;
    if (BUILTIN_NOISE_LABELS.has(node.label ?? '')) continue;
    result.push(node);
    if (result.length >= n) break;
  }
  return result;
}
