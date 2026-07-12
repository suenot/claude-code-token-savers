import { Fragment } from 'react';
import { Card } from '../components/Card.tsx';

// Static comparison — positions shuba against adjacent Claude Code
// token/runtime tools. No API call: the matrix is authored here so it renders
// even when no chain is running. Columns = tools, rows = features (grouped).
// Keep in sync with the README comparison table.

type Cell = 'yes' | 'partial' | 'planned' | 'no';

// Column order is fixed; shuba is first and highlighted.
const TOOLS = [
  { id: 'shuba', name: 'shuba', runtime: 'Bun/TS', self: true },
  { id: 'cmdop', name: 'cmdop-claude', runtime: 'Python' },
  { id: 'graphify', name: 'graphify', runtime: 'Python' },
  { id: 'ccr', name: 'claude-code-router', runtime: 'Node' },
  { id: 'litellm', name: 'LiteLLM', runtime: 'Python' },
  { id: 'headroom', name: 'headroom', runtime: 'Python' },
  { id: 'pxpipe', name: 'pxpipe', runtime: 'Node' },
] as const;

type ToolId = (typeof TOOLS)[number]['id'];
type Row = { feature: string; hint?: string; cells: Partial<Record<ToolId, Cell>> };
type Section = { title: string; rows: Row[] };

// Missing cells default to 'no'.
const SECTIONS: Section[] = [
  {
    title: 'Request / proxy layer (shrink input tokens before they hit the API)',
    rows: [
      {
        feature: 'Content-aware compression',
        hint: 'compress JSON / code / prose in the request body',
        cells: { headroom: 'yes', shuba: 'partial' },
      },
      {
        feature: 'Image/PNG request packing',
        hint: 'render static request parts to dense PNGs (~−59–70% input)',
        cells: { pxpipe: 'yes', shuba: 'partial' },
      },
      {
        feature: 'In-request dedup',
        hint: 'drop identical content blocks Claude Code resends each turn',
        cells: { shuba: 'yes' },
      },
      {
        feature: '/compact routed to cheap model',
        hint: 'compact-router: send only the summarization request to DeepSeek etc.',
        cells: { shuba: 'yes' },
      },
      {
        feature: 'Auto-compact at a token threshold (default 300k)',
        hint: 'context-watchdog summarizes the tail before Claude Code autocompacts; threshold configurable',
        cells: { shuba: 'yes' },
      },
      {
        feature: 'Response / compression cache',
        hint: 'memoize LLM-billed outputs by content hash',
        cells: { shuba: 'yes', litellm: 'yes' },
      },
      { feature: 'Rate limiting', hint: 'pace outbound requests', cells: { shuba: 'yes', litellm: 'yes' } },
      {
        feature: 'Chain proxies behind one BASE_URL',
        hint: 'layer several proxies instead of one owning ANTHROPIC_BASE_URL',
        cells: { shuba: 'yes' },
      },
      {
        feature: 'Provider / model routing',
        hint: 'translate to another provider or route by rule',
        cells: { shuba: 'partial', ccr: 'yes', litellm: 'yes' },
      },
      {
        feature: 'Cheap-model offload',
        hint: 'send some work to a cheaper model',
        cells: { shuba: 'yes', cmdop: 'yes', graphify: 'yes', ccr: 'yes', litellm: 'yes' },
      },
    ],
  },
  {
    title: 'Project intelligence / sidecar (spend cheap tokens so Claude Code spends fewer)',
    rows: [
      {
        feature: 'Task queue injected into prompts',
        hint: 'structured tasks surfaced into the session',
        cells: { shuba: 'yes', cmdop: 'yes' },
      },
      {
        feature: 'Docs review (stale / contradiction / gaps)',
        hint: 'cheap model watches docs so Claude Code does not burn tokens on it',
        cells: { cmdop: 'yes', shuba: 'planned' },
      },
      {
        feature: 'Docs auto-fix (LLM edits)',
        hint: 'generate targeted file edits for a finding',
        cells: { cmdop: 'yes', shuba: 'planned' },
      },
      {
        feature: 'Project map (dir annotations, SHA-cached)',
        hint: 'one-line description per directory, only changed dirs cost tokens',
        cells: { cmdop: 'yes', shuba: 'planned' },
      },
      {
        feature: 'Rules system (lazy paths frontmatter)',
        hint: '.claude/rules/*.md loaded only when relevant files are open',
        cells: { cmdop: 'yes' },
      },
      {
        feature: 'Docs search (FTS5 / semantic)',
        hint: 'BM25 + sqlite-vec search over docs, no external service',
        cells: { cmdop: 'yes' },
      },
      {
        feature: 'Knowledge graph (query instead of read)',
        hint: 'answer from a repo graph instead of dumping files into context',
        cells: { graphify: 'yes', shuba: 'yes' },
      },
      {
        feature: 'God nodes / community detection',
        hint: 'most-connected entities, graph clustering',
        cells: { graphify: 'yes', shuba: 'partial' },
      },
    ],
  },
  {
    title: 'Task delegation / routing (offload whole tasks off Claude Code)',
    rows: [
      {
        feature: 'Delegate a task to a sub-harness via MCP',
        hint: 'shuba_delegate: Claude Code hands a task to opencode/gemini/qwen/cursor-agent/claude',
        cells: { shuba: 'yes' },
      },
      {
        feature: 'LLM-based model/harness routing',
        hint: 'a cheap classifier model (deepseek) picks {harness, model} per task from policy hints',
        cells: { shuba: 'yes' },
      },
      {
        feature: 'Per-job git-worktree isolation',
        hint: 'run a delegated job in an isolated worktree so parallel edits do not collide',
        cells: { shuba: 'yes' },
      },
    ],
  },
  {
    title: 'Ops / visibility',
    rows: [
      {
        feature: 'Console / dashboard UI',
        cells: { shuba: 'yes', litellm: 'yes', pxpipe: 'yes', ccr: 'partial', headroom: 'partial', cmdop: 'partial' },
      },
      {
        feature: 'Live savings telemetry',
        hint: 'measured token savings, not estimates',
        cells: { shuba: 'yes', pxpipe: 'yes', headroom: 'partial' },
      },
    ],
  },
];

const MARK: Record<Cell, { text: string; color: string; label: string }> = {
  yes: { text: '✓', color: '#2ecc71', label: 'built-in' },
  partial: { text: '~', color: '#e0a800', label: 'partial / via a stage' },
  planned: { text: '◐', color: '#3498db', label: 'planned in shuba' },
  no: { text: '·', color: '#ccc', label: 'not offered' },
};

function Mark({ cell }: { cell: Cell }) {
  const m = MARK[cell];
  return (
    <span style={{ color: m.color, fontWeight: 700 }} aria-label={m.label} title={m.label}>
      {m.text}
    </span>
  );
}

const cellTd: React.CSSProperties = {
  padding: '5px 8px',
  borderBottom: '1px solid #f0f0f0',
  textAlign: 'center',
  fontSize: '0.9em',
};
const featTd: React.CSSProperties = {
  padding: '5px 8px',
  borderBottom: '1px solid #f0f0f0',
  fontSize: '0.82em',
  whiteSpace: 'nowrap',
};

export function CompareView() {
  return (
    <>
      <Card title="shuba vs adjacent tools — feature matrix">
        <p style={{ fontSize: '0.85em', color: '#555', marginTop: 0 }}>
          Columns are tools, rows are features. shuba is the <em>orchestrator</em>: it layers the single-purpose
          proxies (headroom, pxpipe) behind one <code>ANTHROPIC_BASE_URL</code> and adds a control MCP that ports
          cmdop-claude's task queue and graphify's native graph. The <strong>Project intelligence</strong> block is
          cmdop-claude's core idea — spend cents on a cheap model to keep docs/maps accurate so Claude Code's scarce
          context is not spent on it; <Mark cell="planned" /> marks that landing in shuba next.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: '760px' }}>
            <thead>
              <tr>
                <th style={{ ...featTd, textAlign: 'left', borderBottom: '2px solid #ccc' }}>feature</th>
                {TOOLS.map((t) => (
                  <th
                    key={t.id}
                    style={{
                      ...cellTd,
                      borderBottom: '2px solid #ccc',
                      fontSize: '0.78em',
                      background: (('self' in t) && t.self) ? '#eafff2' : undefined,
                    }}
                    title={t.runtime}
                  >
                    {t.name}
                    <div style={{ fontWeight: 400, color: '#999', fontSize: '0.9em' }}>{t.runtime}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SECTIONS.map((section) => (
                <Fragment key={section.title}>
                  <tr>
                    <td
                      colSpan={TOOLS.length + 1}
                      style={{
                        padding: '8px',
                        fontSize: '0.78em',
                        fontWeight: 700,
                        color: '#444',
                        background: '#f7f7f7',
                        borderBottom: '1px solid #e0e0e0',
                      }}
                    >
                      {section.title}
                    </td>
                  </tr>
                  {section.rows.map((row) => (
                    <tr key={row.feature}>
                      <td style={featTd} title={row.hint}>
                        {row.feature}
                        {row.hint && <span style={{ color: '#bbb' }}> ⓘ</span>}
                      </td>
                      {TOOLS.map((t) => (
                        <td key={t.id} style={{ ...cellTd, background: (('self' in t) && t.self) ? '#eafff2' : undefined }}>
                          <Mark cell={row.cells[t.id] ?? 'no'} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: '0.8em', color: '#666', marginTop: '12px' }}>
          <Mark cell="yes" /> built-in &nbsp;·&nbsp; <Mark cell="partial" /> partial / via a stage &nbsp;·&nbsp;{' '}
          <Mark cell="planned" /> planned in shuba &nbsp;·&nbsp; <Mark cell="no" /> not offered. Hover a feature (ⓘ) for
          detail. Cells reflect each tool's primary design intent, not a benchmark.
        </p>
      </Card>

      <Card title="Pick by need">
        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.85em', lineHeight: 1.55 }}>
          <li>
            Whole request smaller → <strong>headroom</strong> (content) / <strong>pxpipe</strong> (images) — shuba runs
            them for you.
          </li>
          <li>
            Keep docs accurate + auto-fix, project map, rules → <strong>cmdop-claude</strong> (shuba: task queue today,
            docs review <Mark cell="planned" /> next).
          </li>
          <li>
            Query a repo instead of reading it → <strong>graphify</strong> (shuba embeds a native reader).
          </li>
          <li>
            Swap providers / route by model → <strong>claude-code-router</strong> / <strong>LiteLLM</strong>.
          </li>
          <li>
            Stack all of the above behind one endpoint, with a task queue + graph in one process → <strong>shuba</strong>.
          </li>
        </ul>
        <p style={{ fontSize: '0.8em', color: '#888', marginTop: '12px', marginBottom: 0 }}>
          Not affiliated with any listed project.
        </p>
      </Card>
    </>
  );
}
