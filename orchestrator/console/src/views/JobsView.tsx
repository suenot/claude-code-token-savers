import { useCallback, useEffect, useState } from 'react';
import { getJobResult, getJobs } from '../api.ts';
import type { Job, JobResultResponse } from '../types.ts';
import { Card } from '../components/Card.tsx';
import { DelegateForm } from '../components/DelegateForm.tsx';
import { useInterval } from '../hooks/useInterval.ts';
import { useLogStream } from '../hooks/useLogStream.ts';

const POLL_MS = 2000;

const cellStyle = { padding: '4px 8px' };
const headStyle = { textAlign: 'left' as const, borderBottom: '1px solid #ddd', padding: '4px 8px' };

function elapsedLabel(job: Job): string {
  if (job.startedAt === null) {
    return '-';
  }
  const end = job.endedAt ?? Date.now();
  const ms = end - job.startedAt;
  return `${Math.round(ms / 1000)}s`;
}

export function JobsView() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logJobId, setLogJobId] = useState<string | null>(null);
  const [resultJobId, setResultJobId] = useState<string | null>(null);
  const [result, setResult] = useState<JobResultResponse | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const { lines, start: startLogStream, stop: stopLogStream } = useLogStream();

  const refresh = useCallback(() => {
    getJobs()
      .then((data) => {
        setJobs(data);
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

  const handleViewLogs = (id: string) => {
    setLogJobId(id);
    startLogStream(id);
  };

  const handleCloseLogs = () => {
    setLogJobId(null);
    stopLogStream();
  };

  const handleViewResult = (id: string) => {
    setResultJobId(id);
    setResult(null);
    setResultError(null);
    getJobResult(id)
      .then((res) => {
        setResult(res);
      })
      .catch((err: unknown) => {
        setResultError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <div>
      <DelegateForm onDelegated={refresh} />
      <Card title="Jobs">
        {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
        {!error && jobs === null && <p>Loading...</p>}
        {!error && jobs !== null && jobs.length === 0 && <p>No jobs.</p>}
        {!error && jobs !== null && jobs.length > 0 && (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={headStyle}>id</th>
                <th style={headStyle}>status</th>
                <th style={headStyle}>harness</th>
                <th style={headStyle}>model</th>
                <th style={headStyle}>elapsed</th>
                <th style={headStyle}></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td style={cellStyle}>{job.id}</td>
                  <td style={cellStyle}>{job.status}</td>
                  <td style={cellStyle}>{job.harness}</td>
                  <td style={cellStyle}>{job.model ?? '-'}</td>
                  <td style={cellStyle}>{elapsedLabel(job)}</td>
                  <td style={cellStyle}>
                    <button type="button" onClick={() => handleViewLogs(job.id)} style={{ marginRight: '4px' }}>
                      logs
                    </button>
                    <button type="button" onClick={() => handleViewResult(job.id)}>
                      result
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {logJobId && (
        <Card title={`Logs: ${logJobId}`}>
          <button type="button" onClick={handleCloseLogs} style={{ marginBottom: '8px' }}>
            close
          </button>
          <pre
            style={{
              backgroundColor: '#111',
              color: '#0f0',
              padding: '8px',
              maxHeight: '300px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {lines.join('')}
          </pre>
        </Card>
      )}

      {resultJobId && (
        <Card title={`Result: ${resultJobId}`}>
          {resultError && <p style={{ color: '#e74c3c' }}>Error: {resultError}</p>}
          {!resultError && result === null && <p>Loading...</p>}
          {!resultError && result !== null && 'error' in result && (
            <p style={{ color: '#e74c3c' }}>Error: {result.error}</p>
          )}
          {!resultError && result !== null && !('error' in result) && (
            <div>
              <p>
                status: {result.status} | exit_code: {result.exit_code ?? '-'} | log_path: {result.log_path}
              </p>
              <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: '6px', padding: '10px' }}>
                {result.result}
              </pre>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
