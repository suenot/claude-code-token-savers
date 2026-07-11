import { useCallback, useEffect, useState } from 'react';
import { getToggles, setToggle } from '../api.ts';
import type { ToggleRow } from '../types.ts';
import { Card } from '../components/Card.tsx';

const badgeStyle = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: '10px',
  fontSize: '0.75em',
  marginLeft: '8px',
};

const liveBadgeStyle = { ...badgeStyle, backgroundColor: '#e6f6ea', color: '#1e7e34' };
const restartBadgeStyle = { ...badgeStyle, backgroundColor: '#fdf3e3', color: '#946200' };

export function TogglesView() {
  const [toggles, setToggles] = useState<ToggleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getToggles()
      .then((data) => {
        setToggles(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = useCallback((row: ToggleRow) => {
    const next = !row.enabled;
    setPending(row.id);
    setMessage(null);
    setToggle(row.id, next)
      .then((data) => {
        setToggles(data);
        setError(null);
        setMessage(`${row.id} → ${next ? 'enabled' : 'disabled'}`);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setPending(null);
      });
  }, []);

  return (
    <Card title="Stage toggles">
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
      {message && !error && <p style={{ color: '#1e7e34' }}>{message}</p>}
      {!error && toggles === null && <p>Loading...</p>}
      {!error && toggles !== null && toggles.length === 0 && <p>No stages.</p>}
      {!error && toggles !== null && toggles.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {toggles.map((row) => (
            <li key={row.id} style={{ padding: '6px 0', display: 'flex', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={row.enabled}
                  disabled={pending === row.id}
                  onChange={() => handleToggle(row)}
                  style={{ marginRight: '8px' }}
                />
                <strong>{row.id}</strong>
              </label>
              {row.live && <span style={liveBadgeStyle}>live</span>}
              {row.restartRequired && <span style={restartBadgeStyle}>restart needed</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
