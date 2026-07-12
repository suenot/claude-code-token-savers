import { useCallback, useEffect, useState } from 'react';
import { getStats, getSavings, type Savings } from '../api.ts';
import type { Stats } from '../types.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

// SavedRows renders a "saved tokens" breakdown table (per-model or per-stage)
// straight from the request-log savings summary. Sorted by saved desc.
function SavedRows({ buckets }: { buckets?: Record<string, { in: number; out: number; saved: number; requests: number }> }) {
  const rows = Object.entries(buckets ?? {})
    .map(([name, b]) => ({ name, ...b }))
    .sort((a, b) => b.saved - a.saved);
  if (rows.length === 0) return <p>No measured savings yet.</p>;
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85em' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '4px 8px' }}>name</th>
          <th style={{ textAlign: 'right', borderBottom: '1px solid #ddd', padding: '4px 8px' }}>saved</th>
          <th style={{ textAlign: 'right', borderBottom: '1px solid #ddd', padding: '4px 8px' }}>in→out</th>
          <th style={{ textAlign: 'right', borderBottom: '1px solid #ddd', padding: '4px 8px' }}>reqs</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td style={{ padding: '4px 8px' }}>{r.name}</td>
            <td style={{ padding: '4px 8px', textAlign: 'right', color: '#2ecc71' }}>{r.saved.toLocaleString()}</td>
            <td style={{ padding: '4px 8px', textAlign: 'right', color: '#888' }}>
              {r.in.toLocaleString()}→{r.out.toLocaleString()}
            </td>
            <td style={{ padding: '4px 8px', textAlign: 'right', color: '#888' }}>{r.requests}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const POLL_MS = 2000;
const BAR_WIDTH = 300;
const BAR_HEIGHT = 16;

// extractPct pulls a percentage-ish number out of a stage's arbitrary JSON
// blob (pxpipe/headroom shapes are opaque to the console — see
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
    <div style={{ marginBottom: '8px' }}>
      <div style={{ fontSize: '0.85em', marginBottom: '2px' }}>
        {name}: {pct.toFixed(1)}%
      </div>
      <svg width={BAR_WIDTH} height={BAR_HEIGHT} role="img" aria-label={`${name} saved ${pct.toFixed(1)}%`}>
        <rect x={0} y={0} width={BAR_WIDTH} height={BAR_HEIGHT} fill="#eee" rx={3} />
        <rect x={0} y={0} width={width} height={BAR_HEIGHT} fill="#2ecc71" rx={3} />
      </svg>
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

  return (
    <>
      <Card title="Token savings">
        {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
        {!error && stats === null && <p>Loading...</p>}
        {!error && stats !== null && (
          <>
            <ul style={{ listStyle: 'none', padding: 0, marginBottom: '12px' }}>
              <li>events: {stats.totals.events ?? '—'}</li>
              <li>saved_pct: {stats.totals.saved_pct !== undefined ? `${stats.totals.saved_pct.toFixed(1)}%` : '—'}</li>
            </ul>
            {stages.length === 0 && <p>No stage data yet.</p>}
            {stages.map((stage) => (
              <StageBar key={stage.name} name={stage.name} pct={stage.pct} />
            ))}
          </>
        )}
      </Card>

      <Card title="Saved tokens per model">
        <p style={{ fontSize: '0.8em', color: '#888', marginTop: 0 }}>
          Measured from the request log ({savings ? savings.requests : 0} telemetry-carrying requests). Attributed to
          each request's <code>model</code>.
        </p>
        {savings ? <SavedRows buckets={savings.byModel} /> : <p>Loading...</p>}
      </Card>

      <Card title="Saved tokens per stage (measured)">
        {savings ? <SavedRows buckets={savings.byStage} /> : <p>Loading...</p>}
      </Card>
    </>
  );
}
