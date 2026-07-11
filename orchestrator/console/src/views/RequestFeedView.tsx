import { useCallback, useEffect, useMemo, useState } from 'react';
import { getRequests } from '../api.ts';
import type { RequestFeedEntry } from '../types.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

const POLL_MS = 2000;
const FEED_LIMIT = 100;

function isRequestEvent(value: unknown): value is RequestFeedEntry {
  return typeof value === 'object' && value !== null;
}

function fmtTimestamp(entry: RequestFeedEntry): string {
  const value = entry.ts ?? entry.timestamp;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleTimeString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleTimeString();
  }
  return '—';
}

function fmtCell(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function matchesFilter(entry: RequestFeedEntry, filter: string): boolean {
  if (filter.length === 0) return true;
  const needle = filter.toLowerCase();
  const stage = String(entry.stage ?? entry.source ?? '').toLowerCase();
  const model = String(entry.model ?? '').toLowerCase();
  return stage.includes(needle) || model.includes(needle);
}

export function RequestFeedView() {
  const [requests, setRequests] = useState<RequestFeedEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

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

  const filtered = useMemo(() => {
    if (!requests) return requests;
    return requests.filter((req) => matchesFilter(req, filter));
  }, [requests, filter]);

  return (
    <Card title="Request feed">
      <div style={{ marginBottom: '8px' }}>
        <input
          type="text"
          placeholder="Filter by stage or model..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: '4px 8px', width: '260px' }}
        />
      </div>
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
      {!error && requests === null && <p>Loading...</p>}
      {!error && requests !== null && requests.length === 0 && <p>No requests recorded yet.</p>}
      {!error && filtered !== null && filtered.length === 0 && requests !== null && requests.length > 0 && (
        <p>No requests match "{filter}".</p>
      )}
      {!error && filtered !== null && filtered.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85em' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Time</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Stage/Source</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Path</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Model</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Max tokens</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Action</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Upstream</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Preview</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((req, i) => {
              const isRateLimited = req.upstreamStatus === 429 || req.status === 429;
              return (
                <tr key={i} style={isRateLimited ? { backgroundColor: '#fdecea' } : undefined}>
                  <td style={{ padding: '4px 8px' }}>{fmtTimestamp(req)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.stage ?? req.source)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.path)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.model)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.maxTokens)}</td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.action)}</td>
                  <td
                    style={{
                      padding: '4px 8px',
                      color: isRateLimited ? '#c0392b' : undefined,
                      fontWeight: isRateLimited ? 'bold' : undefined,
                    }}
                  >
                    {fmtCell(req.status)}
                  </td>
                  <td
                    style={{
                      padding: '4px 8px',
                      color: isRateLimited ? '#c0392b' : undefined,
                      fontWeight: isRateLimited ? 'bold' : undefined,
                    }}
                  >
                    {fmtCell(req.upstreamStatus)}
                  </td>
                  <td style={{ padding: '4px 8px' }}>{fmtCell(req.preview)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
