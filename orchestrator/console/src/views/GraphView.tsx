import { useCallback, useEffect, useState } from 'react';
import { getGraph, graphQuery } from '../api.ts';
import type { GraphStatus } from '../types.ts';
import { Card } from '../components/Card.tsx';

export function GraphView() {
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [querying, setQuerying] = useState(false);

  const refresh = useCallback(() => {
    getGraph()
      .then((data) => {
        setStatus(data);
        setStatusError(null);
      })
      .catch((err: unknown) => {
        setStatusError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runQuery = useCallback(() => {
    const q = query.trim();
    if (q.length === 0) return;
    setQuerying(true);
    setQueryError(null);
    graphQuery(q)
      .then((data) => {
        setResult(data.result);
      })
      .catch((err: unknown) => {
        setQueryError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setQuerying(false);
      });
  }, [query]);

  return (
    <>
      <Card title="Graph status">
        {statusError && <p style={{ color: '#e74c3c' }}>Error: {statusError}</p>}
        {!statusError && status === null && <p>Loading...</p>}
        {!statusError && status !== null && (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            <li>built: {status.built ? '✓' : '✗'}</li>
            <li>node_count: {status.node_count}</li>
            <li>watching: {status.watching ? '✓' : '✗'}</li>
          </ul>
        )}
      </Card>
      <Card title="Graph query">
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runQuery();
            }}
            placeholder="ask the graph..."
            style={{ flex: 1, padding: '4px 8px' }}
          />
          <button type="button" onClick={runQuery} disabled={querying || query.trim().length === 0}>
            {querying ? 'Querying...' : 'Query'}
          </button>
        </div>
        {queryError && <p style={{ color: '#e74c3c' }}>Error: {queryError}</p>}
        {!queryError && result !== null && (
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f7f7f7', padding: '8px', borderRadius: '4px' }}>
            {result}
          </pre>
        )}
      </Card>
    </>
  );
}
