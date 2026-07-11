import { execSync } from 'node:child_process';
import { join } from 'node:path';

export type ExecImpl = (cmd: string, opts: { cwd: string }) => string;

export const defaultExec: ExecImpl = (cmd, opts) =>
  execSync(cmd, { cwd: opts.cwd, shell: '/bin/bash' }).toString();

export function createWorktree(
  repoCwd: string,
  id: string,
  execImpl: ExecImpl = defaultExec,
): { path: string } {
  const path = join(repoCwd, '.shuba-worktrees', id);
  execImpl(`git worktree add ${JSON.stringify(path)} -d`, { cwd: repoCwd });
  return { path };
}

export function finalizeWorktree(
  repoCwd: string,
  path: string,
  execImpl: ExecImpl = defaultExec,
): { diff: string; removed: boolean } {
  execImpl('git add -A', { cwd: path });
  const diff = execImpl('git diff --cached', { cwd: path });
  if (diff.trim() === '') {
    execImpl(`git worktree remove --force ${JSON.stringify(path)}`, { cwd: repoCwd });
    return { diff: '', removed: true };
  }
  return { diff, removed: false };
}
