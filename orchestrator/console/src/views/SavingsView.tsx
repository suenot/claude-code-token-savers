import { useCallback, useEffect, useState } from 'react';
import { getStats } from '../api.ts';
import type { Stats } from '../types.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

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
  );
}
