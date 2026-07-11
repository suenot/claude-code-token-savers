import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { JobRecord } from './types.ts';

export type Store = {
  create(rec: Omit<JobRecord, 'status' | 'startedAt' | 'endedAt' | 'exitCode'>): JobRecord;
  get(id: string): JobRecord | undefined;
  list(): JobRecord[];
  update(id: string, patch: Partial<JobRecord>): JobRecord;
  appendLog(id: string, chunk: string): void;
  readLog(id: string): string;
  dir: string;
};

export function createStore(opts: { dir?: string; now?: () => number }): Store {
  const dir = opts.dir ?? join(homedir(), '.shuba', 'jobs');
  const now = opts.now ?? (() => Date.now());
  mkdirSync(dir, { recursive: true });

  const jobs = new Map<string, JobRecord>();
  let counter = 0;

  function jsonPath(id: string): string {
    return join(dir, `${id}.json`);
  }

  function logPath(id: string): string {
    return join(dir, `${id}.log`);
  }

  function persist(rec: JobRecord): void {
    writeFileSync(jsonPath(rec.id), JSON.stringify(rec, null, 2));
  }

  return {
    dir,
    create(rec) {
      counter += 1;
      const id = `job_${now()}_${counter}`;
      const full: JobRecord = {
        ...rec,
        id,
        status: 'queued',
        startedAt: null,
        endedAt: null,
        exitCode: null,
      };
      jobs.set(id, full);
      persist(full);
      return full;
    },
    get(id) {
      return jobs.get(id);
    },
    list() {
      return Array.from(jobs.values());
    },
    update(id, patch) {
      const existing = jobs.get(id);
      if (!existing) throw new Error(`job not found: ${id}`);
      const updated: JobRecord = { ...existing, ...patch };
      jobs.set(id, updated);
      persist(updated);
      return updated;
    },
    appendLog(id, chunk) {
      appendFileSync(logPath(id), chunk);
    },
    readLog(id) {
      const p = logPath(id);
      if (!existsSync(p)) return '';
      return readFileSync(p, 'utf8');
    },
  };
}
