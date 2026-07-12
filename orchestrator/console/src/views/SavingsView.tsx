import { useCallback, useEffect, useState } from 'react';
import { getStats, getSavings, type Savings } from '../api.ts';
import type { Stats } from '../types.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid var(--border-soft)' };

// SavedRows renders a "saved tokens" breakdown table (per-model or per-stage)
// straight from the request-log savings summary. Sorted by saved desc.
function SavedRows({ buckets }: { buckets?: Record<string, { in: number; out: number; saved: number; requests: number }> }) {
  const rows = Object.entries(buckets ?? {})
    .map(([name, b]) => ({ name, ...b }))
    .sort((a, b) => b.saved - a.saved);
  if (rows.length === 0) return <p style={{ color: 'var(--muted)' }}>No measured savings yet.</p>;
  return (
    <table style={{ fontSize: '13px' }}>
      <thead>
        <tr>
          <th style={cell}>name</th>
          <th style={{ ...cell, textAlign: 'right' }}>saved</th>
          <th style={{ ...cell, textAlign: 'right' }}>in→out</th>
          <th style={{ ...cell, textAlign: 'right' }}>reqs</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td style={cell}>{r.name}</td>
            <td style={{ ...cell, textAlign: 'right', color: 'var(--ok)', fontVariantNumeric: 'tabular-nums' }}>
              {r.saved.toLocaleString()}
            </td>
            <td style={{ ...cell, textAlign: 'right', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {r.in.toLocaleString()}→{r.out.toLocaleString()}
            </td>
            <td style={{ ...cell, textAlign: 'right', color: 'var(--muted)' }}>{r.requests}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const POLL_MS = 2000;
const BAR_WIDTH = 320;
const BAR_HEIGHT = 8;

// extractPct pulls a percentage-ish number out of a stage's arbitrary JSON
// blob (headroom shapes are opaque to the console — see
// orchestrator/src/control/collector.ts). Falls back to 0 when no
// recognizable field is present, so a stage still renders an (empty) bar
// rather than being skipped.
function extractPct(value: unknown): number {
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['saved_pct', 'avgSavedPct', 'pct']) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
    }
  }
  return 0;
}

function StageBar({ name, pct }: { name: string; pct: number }) {
  const width = (Math.max(0, Math.min(100, pct)) / 100) * BAR_WIDTH;
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '13px', marginBottom: '5px', display: 'flex', justifyContent: 'space-between', maxWidth: BAR_WIDTH }}>
        <span>{name}</span>
        <span style={{ color: 'var(--muted)' }}>{pct.toFixed(1)}%</span>
      </div>
      <svg width={BAR_WIDTH} height={BAR_HEIGHT} role="img" aria-label={`${name} saved ${pct.toFixed(1)}%`}>
        <rect x={0} y={0} width={BAR_WIDTH} height={BAR_HEIGHT} fill="#26262a" rx={4} />
        <rect x={0} y={0} width={width} height={BAR_HEIGHT} fill="var(--ok)" rx={4} />
      </svg>
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon: string; label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon} {label}
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function SavingsView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [savings, setSavings] = useState<Savings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getStats()
      .then((data) => {
        setStats(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    // Per-model / per-stage measured savings come from the request log; a
    // failure here should not blank the whole view, so it is swallowed.
    getSavings()
      .then(setSavings)
      .catch(() => setSavings(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useInterval(refresh, POLL_MS);

  const stages =
    stats === null
      ? []
      : Object.entries(stats)
          .filter(([key, value]) => key !== 'totals' && value !== undefined)
          .map(([key, value]) => ({ name: key, pct: extractPct(value) }));

  const saved = savings?.totalSaved ?? 0;
  const reqs = savings?.requests ?? 0;
  const models = savings ? Object.keys(savings.byModel).length : 0;
  const stageCount = savings ? Object.keys(savings.byStage).length : 0;

  return (
    <>
      <div className="stat-row">
        <Stat icon="💾" label="Saved tokens" value={saved.toLocaleString()} sub={`across ${reqs} requests`} />
        <Stat icon="📊" label="Requests" value={reqs.toLocaleString()} sub="with token telemetry" />
        <Stat icon="🧠" label="Models" value={String(models)} sub="attributed" />
        <Stat icon="🧩" label="Stages" value={String(stageCount)} sub="reporting savings" />
      </div>

      {error && <div className="panel" style={{ color: 'var(--bad)' }}>Error: {error}</div>}

      <Card title="Saved tokens per model">
        <p style={{ fontSize: '12.5px', color: 'var(--muted)', marginTop: 0 }}>
          Measured from the request log — attributed to each request's <code>model</code>.
        </p>
        {savings ? <SavedRows buckets={savings.byModel} /> : <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      </Card>

      <Card title="Saved tokens per stage">
        {savings ? <SavedRows buckets={savings.byStage} /> : <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      </Card>

      <Card title="Stage compression %">
        {!error && stats === null && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
        {stages.length === 0 && stats !== null && <p style={{ color: 'var(--muted)' }}>No stage data yet.</p>}
        {stages.map((stage) => (
          <StageBar key={stage.name} name={stage.name} pct={stage.pct} />
        ))}
      </Card>
    </>
  );
}
