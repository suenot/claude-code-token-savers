import { useState } from 'react';
import type { FormEvent } from 'react';
import { delegate } from '../api.ts';
import type { DelegateInput } from '../types.ts';
import { Card } from './Card.tsx';

type DelegateFormProps = {
  onDelegated?: () => void;
};

const fieldStyle = { display: 'block', width: '100%', marginBottom: '8px' };

export function DelegateForm({ onDelegated }: DelegateFormProps) {
  const [task, setTask] = useState('');
  const [harness, setHarness] = useState('');
  const [model, setModel] = useState('');
  const [isolation, setIsolation] = useState<'none' | 'worktree'>('none');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!task.trim() || submitting) {
      return;
    }

    const input: DelegateInput = { task, isolation };
    if (harness.trim()) {
      input.harness = harness.trim();
    }
    if (model.trim()) {
      input.model = model.trim();
    }

    setSubmitting(true);
    setError(null);
    delegate(input)
      .then((res) => {
        setLastJobId(res.job_id);
        setTask('');
        setHarness('');
        setModel('');
        setIsolation('none');
        onDelegated?.();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Card title="Delegate a job">
      <form onSubmit={handleSubmit}>
        <textarea
          placeholder="task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          rows={3}
          style={fieldStyle}
        />
        <input
          type="text"
          placeholder="harness (optional)"
          value={harness}
          onChange={(event) => setHarness(event.target.value)}
          style={fieldStyle}
        />
        <input
          type="text"
          placeholder="model (optional)"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          style={fieldStyle}
        />
        <select
          value={isolation}
          onChange={(event) => setIsolation(event.target.value as 'none' | 'worktree')}
          style={fieldStyle}
        >
          <option value="none">none</option>
          <option value="worktree">worktree</option>
        </select>
        <button type="submit" disabled={submitting || !task.trim()}>
          {submitting ? 'Delegating...' : 'Delegate'}
        </button>
      </form>
      {error && <p style={{ color: '#e74c3c' }}>Error: {error}</p>}
      {lastJobId && !error && <p>Delegated as job: {lastJobId}</p>}
    </Card>
  );
}
