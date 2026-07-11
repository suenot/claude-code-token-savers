import { useCallback, useEffect, useState } from 'react';
import { getRequests } from '../api.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

const POLL_MS = 2000;
const FEED_LIMIT = 100;

// The pxpipe events.jsonl schema is loose and not owned by the orchestrator
// (see orchestrator/src/control/collector.ts) — every field below is
// optional and rendered defensively (blank when absent) rather than
// assumed present.
type RequestEvent = {
  timestamp?: string | number;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  reason?: string;
  tokens?: number;
};

function isRequestEvent(value: unknown): value is RequestEvent {
  return typeof value === 'object' && value !== null;
}

function fmtTimestamp(value: unknown): string {
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleTimeString();
  }
  if (typeof value === 'string' && value.length > 0) return value;
  return '—';
}

function fmtCell(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

export function RequestFeedView() {
  const [requests, setRequests] = useState<RequestEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getRequests(FEED_LIMIT)
      .then((data) => {
        setRequests(Array.isArray(data) ? data.filter(isRequestEvent) : []);
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

  return (
    <Card title="Request feed">
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
      {!error && requests === null && <p>Loading...</p>}
      {!error && requests !== null && requests.length === 0 && <p>No requests recorded yet.</p>}
      {!error && requests !== null && requests.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85em' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Time</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Method</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Path</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Duration (ms)</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Reason</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((req, i) => {
              const isRateLimited = req.status === 429;
              return (
                <tr
                  key={i}
                  style={isRateLimited ? { backgroundColor: '#fdecea' } : undefined}
                >
                  <td style={{ padding: '4px 8px' }}>{fmtTimestamp(req.timestamp)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.method)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.path)}</td>
                  <td style={{ padding: '4px 8px', color: isRateLimited ? '#c0392b' : undefined, fontWeight: isRateLimited ? 'bold' : undefined }}>
                    {fmtCell(req.status)}
                  </td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.durationMs)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.reason)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.tokens)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
