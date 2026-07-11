import { useCallback, useEffect, useState } from 'react';
import { getChain } from '../api.ts';
import type { ChainStage } from '../types.ts';
import { Card } from '../components/Card.tsx';
import { useInterval } from '../hooks/useInterval.ts';

const POLL_MS = 2000;

const dotStyle = (healthy: boolean) => ({
  display: 'inline-block',
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  marginRight: '8px',
  backgroundColor: healthy ? '#2ecc71' : '#e74c3c',
});

export function ChainView() {
  const [stages, setStages] = useState<ChainStage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getChain()
      .then((data) => {
        setStages(data);
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
    <Card title="Chain & health">
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
      {!error && stages === null && <p>Loading...</p>}
      {!error && stages !== null && stages.length === 0 && <p>No stages.</p>}
      {!error && stages !== null && stages.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {stages.map((stage) => (
            <li key={stage.id} style={{ padding: '4px 0' }}>
              <span style={dotStyle(stage.healthy)} />
              <strong>{stage.id}</strong>
              <span style={{ marginLeft: '8px', color: '#666' }}>:{stage.port}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
