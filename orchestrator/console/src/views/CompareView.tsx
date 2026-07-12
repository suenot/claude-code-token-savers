import type { ReactNode } from 'react';
import { Card } from '../components/Card.tsx';

// Static comparison — positions shuba against adjacent Claude Code
// token/runtime tools. No API call: the matrix is authored here so it renders
// even when no chain is running. Keep in sync with the README comparison table.

type Cell = 'yes' | 'no' | 'partial';

type Tool = {
  name: string;
  what: string; // one-line "what it is"
  runtime: string;
  cells: Record<string, Cell>; // capability id -> support
  self?: boolean; // true for shuba (highlighted row)
};

const CAPS: { id: string; label: string; hint: string }[] = [
  { id: 'proxy', label: 'Request compression', hint: 'transforms the outgoing request (proxy in front of the API)' },
  { id: 'chain', label: 'Chains other proxies', hint: 'layers multiple ANTHROPIC_BASE_URL proxies instead of fighting for the slot' },
  { id: 'offload', label: 'Cheap-model offload', hint: 'routes some work to a cheaper model (DeepSeek / OpenRouter)' },
  { id: 'tasks', label: 'Task queue', hint: 'structured tasks injected into the session' },
  { id: 'graph', label: 'Knowledge graph', hint: 'queryable repo graph instead of full-file reads' },
  { id: 'docs', label: 'Docs review / auto-fix', hint: 'LLM keeps project docs accurate, generates edits' },
  { id: 'console', label: 'Console / UI', hint: 'dashboard for live state and savings' },
];

const TOOLS: Tool[] = [
  {
    name: 'shuba',
    what: 'Orchestrator: chains token-saving proxies + control MCP (task queue, native graph, dedup, cache).',
    runtime: 'Bun / TypeScript',
    self: true,
    cells: { proxy: 'partial', chain: 'yes', offload: 'yes', tasks: 'yes', graph: 'yes', docs: 'no', console: 'yes' },
  },
  {
    name: 'cmdop-claude',
    what: 'Self-maintaining .claude runtime: docs review, project map, task queue, auto-fix (~$0.003/cycle on DeepSeek).',
    runtime: 'Python',
    cells: { proxy: 'no', chain: 'no', offload: 'yes', tasks: 'yes', graph: 'no', docs: 'yes', console: 'partial' },
  },
  {
    name: 'graphify',
    what: 'Turns any input into a queryable knowledge graph (god nodes, community detection, path/explain).',
    runtime: 'Python',
    cells: { proxy: 'no', chain: 'no', offload: 'yes', tasks: 'no', graph: 'yes', docs: 'no', console: 'no' },
  },
  {
    name: 'claude-code-router',
    what: 'Routes Claude Code requests to alternate providers/models by rule.',
    runtime: 'Node',
    cells: { proxy: 'partial', chain: 'no', offload: 'yes', tasks: 'no', graph: 'no', docs: 'no', console: 'partial' },
  },
  {
    name: 'LiteLLM proxy',
    what: 'Generic provider gateway (auth, routing, spend) in front of many LLM APIs.',
    runtime: 'Python',
    cells: { proxy: 'partial', chain: 'no', offload: 'yes', tasks: 'no', graph: 'no', docs: 'no', console: 'yes' },
  },
  {
    name: 'headroom',
    what: 'Content-aware compression of request content (JSON/code/prose); reversible cache.',
    runtime: 'Python',
    cells: { proxy: 'yes', chain: 'no', offload: 'no', tasks: 'no', graph: 'no', docs: 'no', console: 'partial' },
  },
  {
    name: 'pxpipe',
    what: 'Renders static request parts to dense PNGs (~−59–70% input tokens).',
    runtime: 'Node',
    cells: { proxy: 'yes', chain: 'no', offload: 'no', tasks: 'no', graph: 'no', docs: 'no', console: 'yes' },
  },
];

const MARK: Record<Cell, { text: string; color: string; label: string }> = {
  yes: { text: '✓', color: '#2ecc71', label: 'yes' },
  partial: { text: '~', color: '#e0a800', label: 'partial' },
  no: { text: '✗', color: '#ccc', label: 'no' },
};

function Mark({ cell }: { cell: Cell }) {
  const m = MARK[cell];
  return (
    <span style={{ color: m.color, fontWeight: 700 }} aria-label={m.label} title={m.label}>
      {m.text}
    </span>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: '1px solid #ddd',
  padding: '6px 8px',
  fontSize: '0.8em',
  verticalAlign: 'bottom',
};
const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f0f0f0', fontSize: '0.85em' };

function Legend(): ReactNode {
  return (
    <p style={{ fontSize: '0.8em', color: '#666', marginTop: '12px' }}>
      <Mark cell="yes" /> built-in &nbsp; <Mark cell="partial" /> partial / via a stage &nbsp; <Mark cell="no" /> not offered
    </p>
  );
}

export function CompareView() {
  return (
    <>
      <Card title="shuba vs adjacent tools">
        <p style={{ fontSize: '0.85em', color: '#555', marginTop: 0 }}>
          shuba is the <em>orchestrator</em>: it layers the single-purpose compressors (headroom, pxpipe) behind one{' '}
          <code>ANTHROPIC_BASE_URL</code>, and folds in a control MCP that ports the best ideas from cmdop-claude (task
          queue) and graphify (native in-process graph) — so one process gives you chaining + tasks + graph instead of
          three disconnected runtimes.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: '640px' }}>
            <thead>
              <tr>
                <th style={th}>tool</th>
                <th style={th}>runtime</th>
                {CAPS.map((c) => (
                  <th key={c.id} style={th} title={c.hint}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TOOLS.map((t) => (
                <tr key={t.name} style={t.self ? { background: '#eafff2' } : undefined}>
                  <td style={{ ...td, fontWeight: t.self ? 700 : 400 }}>{t.name}</td>
                  <td style={{ ...td, color: '#666' }}>{t.runtime}</td>
                  {CAPS.map((c) => (
                    <td key={c.id} style={{ ...td, textAlign: 'center' }}>
                      <Mark cell={t.cells[c.id]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Legend />
      </Card>

      <Card title="What each is for">
        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.85em', lineHeight: 1.5 }}>
          {TOOLS.map((t) => (
            <li key={t.name} style={{ marginBottom: '6px' }}>
              <strong>{t.name}</strong> — {t.what}
            </li>
          ))}
        </ul>
        <p style={{ fontSize: '0.8em', color: '#888', marginTop: '12px', marginBottom: 0 }}>
          Not affiliated with any listed project. Cells reflect each tool's primary design intent, not a benchmark.
        </p>
      </Card>
    </>
  );
}
