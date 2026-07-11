import { execSync } from 'node:child_process';

export type HarnessAdapter = {
  id: string;
  bin: string;
  buildArgs(task: string, opts: { model?: string; files?: string[] }): string[];
  extractResult(stdout: string): string;
};

function defaultExtractResult(stdout: string): string {
  return stdout.trim();
}

export const HARNESSES: Record<string, HarnessAdapter> = {
  opencode: {
    id: 'opencode',
    bin: 'opencode',
    buildArgs(task, opts) {
      const args = ['run'];
      if (opts.model !== undefined) {
        args.push('-m', opts.model);
      }
      args.push('--format', 'json', task);
      return args;
    },
    extractResult(stdout) {
      try {
        return JSON.parse(stdout);
      } catch {
        return defaultExtractResult(stdout);
      }
    },
  },
  gemini: {
    id: 'gemini',
    bin: 'gemini',
    buildArgs(task, opts) {
      const args: string[] = [];
      if (opts.model !== undefined) {
        args.push('-m', opts.model);
      }
      args.push('-p', task);
      return args;
    },
    extractResult: defaultExtractResult,
  },
  qwen: {
    id: 'qwen',
    bin: 'qwen',
    buildArgs(task, opts) {
      const args: string[] = [];
      if (opts.model !== undefined) {
        args.push('-m', opts.model);
      }
      args.push('-p', task);
      return args;
    },
    extractResult: defaultExtractResult,
  },
  'cursor-agent': {
    id: 'cursor-agent',
    bin: 'cursor-agent',
    buildArgs(task, opts) {
      const args = ['-p', task, '--output-format', 'text'];
      if (opts.model !== undefined) {
        args.push('-m', opts.model);
      }
      return args;
    },
    extractResult: defaultExtractResult,
  },
  claude: {
    id: 'claude',
    bin: 'claude',
    buildArgs(task, opts) {
      const args: string[] = [];
      if (opts.model !== undefined) {
        args.push('--model', opts.model);
      }
      args.push('-p', task, '--dangerously-skip-permissions');
      return args;
    },
    extractResult: defaultExtractResult,
  },
};

function which(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectHarnesses(
  whichFn: (bin: string) => boolean = which
): Array<{ id: string; bin: string; installed: boolean }> {
  return Object.values(HARNESSES).map((h) => ({
    id: h.id,
    bin: h.bin,
    installed: whichFn(h.bin),
  }));
}
