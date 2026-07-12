import { useCallback, useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { FunnelChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { getSavingsFunnel, type SavingsFunnel } from '../api.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

// Tree-shaken ECharts build: only the funnel series + tooltip + canvas
// renderer are pulled into the console bundle (no CDN — the console is served
// through the control proxy). See src/components/Icon.tsx for the same rule.
echarts.use([FunnelChart, TooltipComponent, CanvasRenderer]);

const POLL_MS = 2000;

// Single-hue, muted sequential ramp for the "still in flight" stages: the
// baseline is the palest slice, each stage a step darker. Kept mid-toned so
// white slice labels read on both the light and dark console themes. The
// terminal ("actually sent") slice gets the success accent instead, so the eye
// lands on what really left the machine. No rainbow, no gradients (dataviz).
const STAGE_RAMP = ['#8fb8d4', '#6ba3c9', '#4b8fbf', '#2f7ab0', '#1f6597', '#154f78'];

function readVar(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// buildOption turns a SavingsFunnel into an ECharts funnel option. Colors and
// text colors are read from the live CSS variables so it re-themes correctly.
function buildOption(funnel: SavingsFunnel): echarts.EChartsCoreOption {
  const okColor = readVar('--ok', '#4ade80');
  const labelColor = '#ffffff';
  const tooltipBg = readVar('--panel', '#141416');
  const tooltipText = readVar('--text', '#ededef');
  const tooltipBorder = readVar('--border', '#262629');
  const baseline = funnel.baseline || 1;

  const data = funnel.stages.map((s, i) => {
    const color = s.terminal ? okColor : STAGE_RAMP[Math.min(i, STAGE_RAMP.length - 1)];
    return {
      name: s.name,
      value: s.remaining,
      itemStyle: { color, borderColor: 'transparent' },
      // Stash the raw stage for the tooltip formatter.
      _stage: s,
    };
  });

  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      textStyle: { color: tooltipText, fontSize: 12 },
      formatter: (p: any) => {
        const s = p.data?._stage as SavingsFunnel['stages'][number] | undefined;
        if (!s) return '';
        const lines = [
          `<strong>${p.name}</strong>`,
          `${fmt(s.remaining)} tokens · ${s.pctOfBaseline.toFixed(1)}% of baseline`,
        ];
        if (s.kind !== 'baseline') {
          lines.push(`${fmt(s.saved)} removed here · ${(100 - s.pctOfPrev).toFixed(1)}% of previous stage`);
        }
        return lines.join('<br/>');
      },
    },
    series: [
      {
        type: 'funnel',
        // Our data is already ordered top→bottom and descending; keep it.
        sort: 'none',
        top: 12,
        bottom: 12,
        left: '8%',
        width: '84%',
        min: 0,
        max: baseline,
        minSize: '26%',
        maxSize: '100%',
        gap: 3,
        funnelAlign: 'center',
        label: {
          position: 'inside',
          color: labelColor,
          fontSize: 12,
          formatter: (p: any) => {
            const s = p.data?._stage as SavingsFunnel['stages'][number] | undefined;
            if (!s) return p.name;
            return `${p.name}  ·  ${fmt(s.remaining)}  (${s.pctOfBaseline.toFixed(0)}%)`;
          },
        },
        labelLine: { show: false },
        itemStyle: { borderWidth: 0 },
        emphasis: { label: { fontWeight: 'bold' } },
        data,
      },
    ],
  };
}

export function FunnelView() {
  const [funnel, setFunnel] = useState<SavingsFunnel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const funnelRef = useRef<SavingsFunnel | null>(null);

  const refresh = useCallback(() => {
    getSavingsFunnel()
      .then((data) => {
        setFunnel(data);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useInterval(refresh, POLL_MS);

  // Init the chart once the container exists; dispose on unmount.
  useEffect(() => {
    if (!elRef.current) return;
    const chart = echarts.init(elRef.current);
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    // Re-render on theme switch (App writes <html data-theme>): colors are read
    // from CSS vars, so a re-buildOption picks up the new palette.
    const observer = new MutationObserver(() => {
      if (funnelRef.current) chart.setOption(buildOption(funnelRef.current), true);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      window.removeEventListener('resize', onResize);
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // Push new data into the chart whenever it arrives.
  useEffect(() => {
    funnelRef.current = funnel;
    if (funnel && funnel.stages.length > 0 && chartRef.current) {
      chartRef.current.setOption(buildOption(funnel), true);
    }
  }, [funnel]);

  const hasData = funnel !== null && funnel.stages.length > 0;

  return (
    <>
      <div className="stat-row">
        <Stat label="💸 Would-be-sent" value={funnel ? fmt(funnel.baseline) : '—'} sub="tokens without savings" />
        <Stat label="📤 Actually sent" value={funnel ? fmt(funnel.sent) : '—'} sub="forwarded upstream" />
        <Stat label="💾 Saved" value={funnel ? fmt(funnel.totalSaved) : '—'} sub={funnel ? `${funnel.savedPct.toFixed(1)}% of baseline` : undefined} />
        <Stat label="📊 Requests" value={funnel ? funnel.requests.toLocaleString() : '—'} sub="with token telemetry" />
      </div>

      {error && <div className="panel" style={{ color: 'var(--bad)' }}>Error: {error}</div>}

      <Card title="Token-savings funnel">
        <p style={{ fontSize: '12.5px', color: 'var(--muted)', margin: '0 0 10px' }}>
          Top = tokens that would have been sent with no savings layer. Each slice narrows by the tokens a stage
          removed; the green terminal slice is what actually left for the API. Measured from the request log.
        </p>
        <div
          ref={elRef}
          style={{ width: '100%', height: 420, minHeight: 420 }}
          role="img"
          aria-label="Token-savings funnel from baseline to tokens actually sent"
        />
        {funnel !== null && !hasData && (
          <p style={{ color: 'var(--muted)' }}>No measured token savings yet — the funnel appears once requests carry token telemetry.</p>
        )}
        {funnel === null && !error && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
      </Card>

      <p style={{ fontSize: '11.5px', color: 'var(--faint)', maxWidth: 720 }}>
        Note: stages log independently per hop, so a request crossing several stages is counted at each one. The
        per-stage <em>saved</em> amounts stay accurate, but the absolute baseline/sent totals are inflated by
        intermediate hops. A true per-request funnel would need the stages to share a request id across the chain.
      </p>
    </>
  );
}
