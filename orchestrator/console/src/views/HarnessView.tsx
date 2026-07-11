import { useEffect, useState } from 'react';
import { getHarnesses } from '../api.ts';
import type { HarnessRow } from '../types.ts';
import { Card } from '../components/Card.tsx';

export function HarnessView() {
  const [rows, setRows] = useState<HarnessRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHarnesses()
      .then((data) => {
        setRows(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <Card title="Harness registry">
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
      {!error && rows === null && <p>Loading...</p>}
      {!error && rows !== null && rows.length === 0 && <p>No harnesses.</p>}
      {!error && rows !== null && rows.length > 0 && (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '4px 8px' }}>id</th>
              <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: '4px 8px' }}>installed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={{ padding: '4px 8px' }}>{row.id}</td>
                <td style={{ padding: '4px 8px' }}>{row.installed ? '✓' : '✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
