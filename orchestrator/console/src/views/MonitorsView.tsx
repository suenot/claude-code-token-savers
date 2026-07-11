import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getChain, getStats } from '../api.ts';
import type { ChainStage, Stats } from '../types.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

const POLL_MS = 2000;

// extractPct mirrors SavingsView's helper: pulls a percentage-ish number out
// of a stage's arbitrary JSON blob when present.
function extractPct(value: unknown): number | undefined {
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['saved_pct', 'avgSavedPct', 'pct']) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return undefined;
}

function StatCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid #ddd',
        borderRadius: '6px',
        padding: '10px 14px',
        minWidth: '160px',
        marginRight: '12px',
        marginBottom: '12px',
      }}
    >
      <div style={{ fontSize: '0.8em', color: '#888', marginBottom: '4px' }}>{title}</div>
      <div style={{ fontSize: '1.1em' }}>{children}</div>
    </div>
  );
}

// MonitorsView derives best-effort rate-limiter/watchdog signals from the
// existing /api/stats and /api/chain endpoints. Neither the rate-limiter nor
// the watchdog currently exposes dedicated signals through the collector
// (see orchestrator/src/control/collector.ts) — those cards render "n/a"
// rather than fabricating a value.
export function MonitorsView() {
  const [chain, setChain] = useState<ChainStage[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([getChain(), getStats()])
      .then(([chainData, statsData]) => {
        setChain(chainData);
        setStats(statsData);
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

  const healthyCount = chain?.filter((s) => s.healthy).length ?? 0;
  const totalCount = chain?.length ?? 0;
  const headroomPct = stats ? extractPct(stats.headroom) : undefined;

  return (
    <Card title="Monitors">
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
      {!error && (chain === null || stats === null) && <p>Loading...</p>}
      {!error && chain !== null && stats !== null && (
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          <StatCard title="Chain health">
            {totalCount === 0 ? 'n/a' : `${healthyCount}/${totalCount} healthy`}
          </StatCard>
          <StatCard title="Events observed">{stats.totals.events ?? 'n/a'}</StatCard>
          <StatCard title="Headroom / rate-limiter">
            {headroomPct !== undefined ? `${headroomPct.toFixed(1)}%` : 'n/a'}
          </StatCard>
          <StatCard title="Watchdog">n/a</StatCard>
        </div>
      )}
    </Card>
  );
}
