#!/usr/bin/env bun
// In the compiled binary (bun build --compile) the built-in stage modules are
// embedded and the supervisor spawns them as `<shuba-binary> <$bunfs-path>` —
// process.execPath IS the shuba binary, so the module path arrives as our
// first CLI arg instead of being run by bun directly (which is what happens
// in dev, where execPath is the real bun and it executes the script itself).
// Dispatch those paths to their modules here; the import specifiers must stay
// literal so `bun build` bundles every stage into the binary.
export {}; // top-level await needs module context under tsc

const STAGE_MODULES: Record<string, () => Promise<unknown>> = {
  'compact-interceptor': () => import('./compact-interceptor.ts'),
  'context-watchdog': () => import('./context-watchdog.ts'),
  'rate-limiter': () => import('./rate-limiter.ts'),
  'dedup': () => import('./dedup.ts'),
  'crush': () => import('./crush.ts'),
  'skill-inject': () => import('./skill-inject.ts'),
  'shuba-image-shrink': () => import('./shuba-image-shrink.ts'),
  'shuba-model-router': () => import('./shuba-model-router.ts'),
  'shuba-control': () => import('./shuba-control.ts'),
};

const first = process.argv[2] ?? '';
const stage = first.endsWith('.ts') ? (first.split('/').pop() ?? '').slice(0, -3) : '';

if (stage && STAGE_MODULES[stage]) {
  // Stage scripts read env and start their server on import. Shift argv so a
  // stage that inspects positional args sees the same shape as under dev bun
  // (argv[1] = its module path, extras after it).
  process.argv = [process.argv[0]!, first, ...process.argv.slice(3)];
  void STAGE_MODULES[stage]!();
} else {
  const { cli } = await import('../src/cli.ts');
  void cli(process.argv.slice(2)).then((code) => process.exit(code));
}
