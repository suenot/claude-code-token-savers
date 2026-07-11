import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export type ExecImpl = (file: string, args: string[], opts: { cwd: string }) => string;

export const defaultExec: ExecImpl = (file, args, opts) =>
  execFileSync(file, args, { cwd: opts.cwd }).toString();

export function createWorktree(
  repoCwd: string,
  id: string,
  execImpl: ExecImpl = defaultExec,
): { path: string } {
  const path = join(repoCwd, '.shuba-worktrees', id);
  execImpl('git', ['worktree', 'add', path, '-d'], { cwd: repoCwd });
  return { path };
}

export function finalizeWorktree(
  repoCwd: string,
  path: string,
  execImpl: ExecImpl = defaultExec,
): { diff: string; removed: boolean } {
  execImpl('git', ['add', '-A'], { cwd: path });
  const diff = execImpl('git', ['diff', '--cached'], { cwd: path });
  if (diff.trim() === '') {
    execImpl('git', ['worktree', 'remove', '--force', path], { cwd: repoCwd });
    return { diff: '', removed: true };
  }
  return { diff, removed: false };
}
