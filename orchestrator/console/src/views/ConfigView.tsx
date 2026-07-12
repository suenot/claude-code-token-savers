import { useCallback, useEffect, useState } from 'react';
import { getConfig } from '../api.ts';
import { Card } from '../components/Card.tsx';

export function ConfigView() {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    getConfig()
      .then((data) => {
        setConfig(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const pretty = config === null ? '' : JSON.stringify(config, null, 2);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(pretty).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Clipboard access can fail (permissions, non-secure context); ignore
        // silently rather than surfacing a confusing error for a copy button.
      },
    );
  }, [pretty]);

  return (
    <Card title="Config">
      <p style={{ color: '#666', fontSize: '0.9em' }}>
        Read-only. Secret-looking fields (api keys, tokens) are stripped by the server. Live-editing is deferred.
      </p>
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
      {!error && config === null && <p>Loading...</p>}
      {!error && config !== null && (
        <>
          <button type="button" onClick={copy} style={{ marginBottom: '8px' }}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel-2)', border: '1px solid var(--border)', padding: '10px', borderRadius: '6px' }}>
            {pretty}
          </pre>
        </>
      )}
    </Card>
  );
}
