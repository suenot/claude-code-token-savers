// Thin typed fetch wrappers over the shuba control HTTP routes
// (orchestrator/src/control/http.ts). Same-origin, relative-URL fetches —
// the SPA is served by the same control server it talks to.
import type {
  ChainStage,
  DelegateInput,
  DelegateResponse,
  GraphQueryResult,
  GraphStatus,
  HarnessRow,
  Job,
  JobResultResponse,
  JobStatusResponse,
  Stats,
  ToggleRow,
} from './types.ts';

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function toJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new ApiError(res.status, `request failed: ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return toJson<T>(res);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return toJson<T>(res);
}

export function getChain(): Promise<ChainStage[]> {
  return getJson<ChainStage[]>('/api/chain');
}

export function getStats(): Promise<Stats> {
  return getJson<Stats>('/api/stats');
}

export type Savings = {
  totalIn: number;
  totalOut: number;
  totalSaved: number;
  requests: number;
  byStage: Record<string, { in: number; out: number; saved: number; requests: number }>;
};

// getSavings fetches aggregated token-savings telemetry (GET /api/savings).
export function getSavings(): Promise<Savings> {
  return getJson<Savings>('/api/savings');
}

// getRequests fetches the most recent per-hop request-feed entries
// (newest-first). The schema is loose so the return type is left as
// unknown[] — callers must render defensively.
export function getRequests(limit = 100): Promise<unknown[]> {
  return getJson<unknown[]>(`/api/requests?limit=${encodeURIComponent(String(limit))}`);
}

export function getJobs(): Promise<Job[]> {
  return getJson<Job[]>('/api/jobs');
}

export function getJob(id: string): Promise<JobStatusResponse> {
  return getJson<JobStatusResponse>(`/api/jobs/${id}`);
}

export function getJobResult(id: string): Promise<JobResultResponse> {
  return getJson<JobResultResponse>(`/api/jobs/${id}/result`);
}

export function delegate(input: DelegateInput): Promise<DelegateResponse> {
  return postJson<DelegateResponse>('/api/delegate', input);
}

export function getHarnesses(): Promise<HarnessRow[]> {
  return getJson<HarnessRow[]>('/api/harnesses');
}

export function getGraph(): Promise<GraphStatus> {
  return getJson<GraphStatus>('/api/graph');
}

export function graphQuery(query: string): Promise<GraphQueryResult> {
  return postJson<GraphQueryResult>('/api/graph/query', { query });
}

// getConfig fetches the running orchestrator config with secret-ish fields
// (matching /apikey|secret|token/i) already stripped server-side.
export function getConfig(): Promise<Record<string, unknown>> {
  return getJson<Record<string, unknown>>('/api/config');
}

// getToggles fetches the live/config-enabled state of every known shuba
// chain stage (see orchestrator/src/control/toggles.ts).
export function getToggles(): Promise<ToggleRow[]> {
  return getJson<ToggleRow[]>('/api/toggles');
}

// setToggle flips a single stage's enabled flag and persists it. The POST
// requires a JSON content-type (CSRF guard on the control server) — always
// go through postJson rather than a raw fetch. Returns the updated full
// list, same shape as getToggles.
export function setToggle(stage: string, enabled: boolean): Promise<ToggleRow[]> {
  return postJson<ToggleRow[]>('/api/toggles', { stage, enabled });
}

// openLogStream opens a WebSocket against /api/stream/logs/:id and invokes
// onChunk for every text frame received. Returns a close function. Relies on
// browser globals (WebSocket, location) that are absent under `bun test` —
// callers in a non-browser environment must not invoke this.
export function openLogStream(id: string, onChunk: (chunk: string) => void): () => void {
  const ws = new WebSocket(`ws://${location.host}/api/stream/logs/${id}`);
  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      onChunk(event.data);
    }
  };
  return () => {
    ws.close();
  };
}
