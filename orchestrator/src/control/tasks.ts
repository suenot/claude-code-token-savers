import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Task queue: findings/todos surfaced by shuba (or added manually) live as
// one markdown file per task under `<project>/.shuba/tasks/`, YAML-frontmatter
// + body — ported from cmdop-claude's TaskManager
// (https://github.com/commandoperator/cmdop-claude, src/sidecar/tasks/tasks.py).
// Git-friendly (diffable, one file per task) and readable outside shuba.

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type TaskStatus = 'pending' | 'completed' | 'dismissed';

export type SidecarTask = {
  id: string;
  priority: TaskPriority;
  status: TaskStatus;
  title: string;
  description: string;
  contextFiles?: string[];
  source: string;
  createdAt: string;
  completedAt?: string;
};

export type CreateTaskInput = {
  priority: TaskPriority;
  title: string;
  description: string;
  contextFiles?: string[];
  source?: string;
};

const PRIORITY_ORDER: Record<TaskPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function serializeFrontmatter(task: SidecarTask): string {
  const lines = [
    `id: ${task.id}`,
    `priority: ${task.priority}`,
    `status: ${task.status}`,
    `title: ${JSON.stringify(task.title)}`,
    `source: ${task.source}`,
    `created_at: ${task.createdAt}`,
  ];
  if (task.completedAt) lines.push(`completed_at: ${task.completedAt}`);
  if (task.contextFiles && task.contextFiles.length > 0) {
    lines.push(`context_files: ${JSON.stringify(task.contextFiles)}`);
  }
  return `---\n${lines.join('\n')}\n---\n${task.description}\n`;
}

// Tolerant parser for the flat `key: value` frontmatter written above —
// values are either a JSON literal (arrays, quoted strings) or a bare
// scalar (dates, ids, enum values), never nested YAML.
function parseTaskFile(raw: string): SidecarTask | undefined {
  if (!raw.startsWith('---\n')) return undefined;
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) return undefined;
  const fmBlock = raw.slice(4, end);
  const body = raw.slice(end + 5);

  const meta: Record<string, unknown> = {};
  for (const line of fmBlock.split('\n')) {
    if (!line.trim()) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const rawValue = line.slice(sep + 1).trim();
    try {
      meta[key] = JSON.parse(rawValue);
    } catch {
      meta[key] = rawValue;
    }
  }

  if (typeof meta.id !== 'string' || typeof meta.priority !== 'string' || typeof meta.created_at !== 'string') {
    return undefined;
  }
  return {
    id: meta.id,
    priority: meta.priority as TaskPriority,
    status: (typeof meta.status === 'string' ? meta.status : 'pending') as TaskStatus,
    title: typeof meta.title === 'string' ? meta.title : 'Untitled',
    description: body.replace(/\n$/, ''),
    contextFiles: Array.isArray(meta.context_files) ? (meta.context_files as string[]) : undefined,
    source: typeof meta.source === 'string' ? meta.source : 'manual',
    createdAt: meta.created_at,
    completedAt: typeof meta.completed_at === 'string' ? meta.completed_at : undefined,
  };
}

export type TaskManager = {
  createTask(input: CreateTaskInput): SidecarTask;
  listTasks(status?: TaskStatus): SidecarTask[];
  getTask(id: string): SidecarTask | undefined;
  updateStatus(id: string, status: TaskStatus): boolean;
  getPendingSummary(maxItems?: number): string;
};

export function createTaskManager(tasksDir: string): TaskManager {
  function ensureDir(): void {
    mkdirSync(tasksDir, { recursive: true });
  }

  function readAll(): SidecarTask[] {
    if (!existsSync(tasksDir)) return [];
    const tasks: SidecarTask[] = [];
    for (const name of readdirSync(tasksDir).sort()) {
      if (!name.endsWith('.md')) continue;
      try {
        const parsed = parseTaskFile(readFileSync(join(tasksDir, name), 'utf8'));
        if (parsed) tasks.push(parsed);
      } catch {
        // skip unreadable/corrupt task file rather than failing the whole list
      }
    }
    return tasks;
  }

  function nextId(): string {
    let max = 0;
    for (const t of readAll()) {
      const m = /^T-(\d+)$/.exec(t.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `T-${String(max + 1).padStart(3, '0')}`;
  }

  function writeTask(task: SidecarTask): void {
    ensureDir();
    writeFileSync(join(tasksDir, `${task.id}.md`), serializeFrontmatter(task));
  }

  function createTask(input: CreateTaskInput): SidecarTask {
    const task: SidecarTask = {
      id: nextId(),
      priority: input.priority,
      status: 'pending',
      title: input.title,
      description: input.description,
      contextFiles: input.contextFiles,
      source: input.source ?? 'manual',
      createdAt: new Date().toISOString(),
    };
    writeTask(task);
    return task;
  }

  function listTasks(status?: TaskStatus): SidecarTask[] {
    const all = readAll();
    return status ? all.filter((t) => t.status === status) : all;
  }

  function getTask(id: string): SidecarTask | undefined {
    if (!existsSync(join(tasksDir, `${id}.md`))) return undefined;
    try {
      return parseTaskFile(readFileSync(join(tasksDir, `${id}.md`), 'utf8'));
    } catch {
      return undefined;
    }
  }

  function updateStatus(id: string, status: TaskStatus): boolean {
    const task = getTask(id);
    if (!task) return false;
    task.status = status;
    if (status === 'completed' || status === 'dismissed') {
      task.completedAt = new Date().toISOString();
    }
    writeTask(task);
    return true;
  }

  function getPendingSummary(maxItems = 3): string {
    const pending = listTasks('pending').sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    if (pending.length === 0) return '';
    const lines = [`Pending shuba tasks (${pending.length} total):`];
    for (const t of pending.slice(0, maxItems)) {
      lines.push(`- [${t.priority}] ${t.title} (id: ${t.id})`);
      if (t.contextFiles && t.contextFiles.length > 0) {
        lines.push(`  Files: ${t.contextFiles.join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  return { createTask, listTasks, getTask, updateStatus, getPendingSummary };
}
