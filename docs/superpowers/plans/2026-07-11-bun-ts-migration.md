# Bun + TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the entire shuba orchestrator from plain-JS ESM (Node) to TypeScript running on Bun, with zero behavior change and every existing test green.

**Architecture:** Mechanical file-by-file port. Each source `.js` becomes `.ts` with type annotations added and its body preserved verbatim; the existing test suite (which `bun test` already runs unchanged) is the safety net. Shared domain types live in one `types.ts`. `tsc --noEmit` is the compile gate; `bun test` is the behavior gate. Migrate leaves first, then mid-layer, then `cli`, then servers+bins, so the chain is never broken mid-migration.

**Tech Stack:** Bun 1.3.x runtime, TypeScript (strict), `node:test`/`node:assert` (run by Bun, no rewrite), MCP/other libs untouched.

## Global Constraints

- Runtime: Bun `>=1.1` (dev machine has 1.3.11). Bins use `#!/usr/bin/env bun`.
- No behavior change — the proxy chain, compact-router, context-watchdog, rate-limiter must behave identically. All existing tests pass after each task.
- No new features (shuba-control, graphify, console are separate specs).
- Keep every `node:` built-in import as-is (`node:http`, `node:stream`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:url`, `node:events`) — Bun supports them; do not rewrite I/O.
- Tests keep `node:test` + `node:assert/strict` imports (option A). Do not rewrite to `bun:test`.
- Type-check gate: `bunx tsc --noEmit` clean under `strict: true`.
- Test bodies are preserved verbatim except the file extension and any `.js` import specifiers updated to extensionless/`.ts` as needed.
- Builtin stages re-spawn via `process.execPath` (now the Bun binary) with a `.ts` bin path — smoke-test each after porting.

---

### Task 1: Bun toolchain + baseline green

**Files:**
- Modify: `orchestrator/package.json`
- Create: `orchestrator/tsconfig.json`
- Create: `orchestrator/.gitignore` (add `console/dist`, `*.tsbuildinfo` — created later, harmless now)

**Interfaces:**
- Produces: `package.json` scripts `test` (`bun test`), `typecheck` (`tsc --noEmit`), `build` (compile bin); `tsconfig.json` with strict settings consumed by every later task's `typecheck` step.

- [ ] **Step 1: Confirm the existing suite runs under Bun (baseline)**

Run: `cd orchestrator && bun test`
Expected: `70 pass`, `0 fail`. (This is the behavior baseline every later task must preserve.)

- [ ] **Step 2: Add `@types/bun` and TypeScript as dev deps**

Run: `cd orchestrator && bun add -d typescript @types/bun`
Expected: both appear in `package.json` `devDependencies`.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*.ts", "bin/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Update `package.json` scripts + engines + bin**

```json
{
  "name": "shuba",
  "version": "0.1.0",
  "type": "module",
  "bin": { "shuba": "./bin/shuba.ts" },
  "engines": { "bun": ">=1.1" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "build": "bun build ./bin/shuba.ts --compile --outfile shuba"
  },
  "license": "MIT"
}
```

- [ ] **Step 5: Verify typecheck runs (no `.ts` files yet → clean)**

Run: `cd orchestrator && bun run typecheck`
Expected: exits 0 (nothing to check yet) or reports only that no inputs were found — treat "No inputs" as acceptable at this step.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/package.json orchestrator/tsconfig.json orchestrator/bun.lockb orchestrator/.gitignore
git commit -m "chore(orchestrator): add Bun+TS toolchain (tsconfig, scripts, deps)"
```

---

### Task 2: Shared domain types

**Files:**
- Create: `orchestrator/src/types.ts`

**Interfaces:**
- Produces: `StageDescriptor`, `BuildContext`, `BuildResult`, `Config`, `StageConfig` blocks, `PlannedStage`, `PlanResult`, `ChainHandle` — imported by registry/planner/supervisor/cli tasks.

- [ ] **Step 1: Write `src/types.ts`**

```ts
export type BuildContext = {
  port: number;
  upstreamBase?: string;
  provider?: string;
  config?: Config;
};

export type BuildResult = { args: string[]; env: Record<string, string> };

export type StageDescriptor = {
  id: string;
  bin: string;
  defaultPort: number;
  dialect: 'anthropic' | 'translates';
  terminal: boolean;
  healthPath: string;
  builtin?: boolean;
  requiresToken?: boolean;
  readerConstraint?: string;
  clientPathSuffix?: string;
  build(ctx: BuildContext): BuildResult;
};

export type Config = {
  terminal: string;
  compressors: string[];
  ports?: Record<string, number>;
  compactRouter?: { model?: string; baseUrl?: string; envKey?: string };
  contextWatchdog?: {
    model?: string; baseUrl?: string; envKey?: string;
    thresholdTokens?: number; tailTurns?: number;
  };
  rateLimiter?: { rps?: number; burst?: number; cooldownMs?: number };
};

export type PlannedStage = {
  id: string;
  port: number;
  baseUrl: string;
  upstreamBase?: string;
  provider?: string;
  healthUrl: string;
  spawn: { bin: string; args: string[]; env: Record<string, string> };
};

export type PlanResult =
  | { ok: true; chain: PlannedStage[]; head: { baseUrl: string; requiresToken: boolean } }
  | { ok: false; errors: string[] };

export type ChainHandle = {
  down(): Promise<void>;
  status(): Array<{ id: string; pid: number | undefined; port: number }>;
};
```

- [ ] **Step 2: Typecheck**

Run: `cd orchestrator && bun run typecheck`
Expected: PASS (0 errors).

- [ ] **Step 3: Commit**

```bash
git add orchestrator/src/types.ts
git commit -m "feat(orchestrator): shared domain types for the chain"
```

---

### Task 3: Port `config`

**Files:**
- Create: `orchestrator/src/config.ts` (from `config.js`)
- Rename: `orchestrator/test/config.test.js` → `config.test.ts`
- Delete: `orchestrator/src/config.js` (after green)

**Interfaces:**
- Consumes: `Config` from `src/types.ts`.
- Produces: `DEFAULT_CONFIG: Config`, `configPath(home?: string): string`, `loadConfig(path?: string): { config: Config; created: boolean }`.

- [ ] **Step 1: Create `src/config.ts` — body verbatim from `config.js`, with these typed signatures**

Preserve the existing body exactly; change only the signatures/annotations:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from './types.ts';

export const DEFAULT_CONFIG: Config = { terminal: 'anthropic', compressors: ['headroom'], ports: {} };

export function configPath(home: string = homedir()): string {
  return join(home, '.shuba', 'chain.json');
}

export function loadConfig(path: string = configPath()): { config: Config; created: boolean } {
  // ...body unchanged from config.js...
}
```

- [ ] **Step 2: Rename the test and update the import specifier**

Run: `cd orchestrator && git mv test/config.test.js test/config.test.ts`
Then change its import from `'../src/config.js'` to `'../src/config.ts'`. Test body otherwise unchanged.

- [ ] **Step 3: Delete the old `.js` source**

Run: `cd orchestrator && git rm src/config.js`

- [ ] **Step 4: Run tests + typecheck**

Run: `cd orchestrator && bun test test/config.test.ts && bun run typecheck`
Expected: config tests PASS; typecheck 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port config to TypeScript"
```

---

### Task 4: Port `compact/` leaves (translate, matcher)

**Files:**
- Create: `orchestrator/src/compact/translate.ts`, `orchestrator/src/compact/matcher.ts`
- Rename: `test/compact-translate.test.js` → `.ts`, `test/compact-matcher.test.js` → `.ts`
- Delete: the two `.js` sources after green

**Interfaces:**
- Produces (matcher): `isCompactRequest(body: any): boolean`.
- Produces (translate): `anthropicToOpenAI(body: any, model: string): any`, `openAIMessageToAnthropic(text: string, opts): any`, `anthropicSSEChunks(text: string, opts): string[]`, `mapStopReason(finish: string | null | undefined): string`. (Keep the exact names/exports the current `.js` files expose — verify by reading them first.)

- [ ] **Step 1: Read the two source files to capture exact exports and bodies**

Run: `cd orchestrator && cat src/compact/matcher.js src/compact/translate.js`

- [ ] **Step 2: Create `.ts` twins — bodies verbatim, add param/return annotations**

Annotate each exported function's params and return type. Where a shape is genuinely dynamic (Anthropic/OpenAI request JSON), type it as `any` (documented pragmatic choice — no runtime schema). Keep all internal logic identical.

- [ ] **Step 3: Rename tests, update import specifiers `.js`→`.ts`**

Run: `cd orchestrator && git mv test/compact-translate.test.js test/compact-translate.test.ts && git mv test/compact-matcher.test.js test/compact-matcher.test.ts`
Update imports inside each to point at `.ts`.

- [ ] **Step 4: Delete old sources**

Run: `cd orchestrator && git rm src/compact/matcher.js src/compact/translate.js`

- [ ] **Step 5: Tests + typecheck**

Run: `cd orchestrator && bun test test/compact-matcher.test.ts test/compact-translate.test.ts && bun run typecheck`
Expected: PASS; 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port compact translate+matcher to TypeScript"
```

---

### Task 5: Port `watchdog/` leaves (estimate, cut, rewrite)

**Files:**
- Create: `src/watchdog/estimate.ts`, `src/watchdog/cut.ts`, `src/watchdog/rewrite.ts`
- Rename: `test/watchdog-estimate.test.js`, `test/watchdog-cut.test.js`, `test/watchdog-rewrite.test.js` → `.ts`
- Delete: the three `.js` sources after green

**Interfaces:**
- Produces: `estimateTokens(body: { system?: any; messages?: any[] }): number`; `planCut(messages: any[], tailTurns: number): { older: any[]; tail: any[] } | null`; `summaryKey(messages: any[]): string`, `buildRewrittenBody(body: any, tail: any[], summary: string): any`. (Confirm exact names against the source before annotating.)

- [ ] **Step 1: Read sources for exact exports**

Run: `cd orchestrator && cat src/watchdog/estimate.js src/watchdog/cut.js src/watchdog/rewrite.js`

- [ ] **Step 2: Create `.ts` twins — bodies verbatim + annotations**

Add typed signatures as in the Interfaces block; internal logic unchanged.

- [ ] **Step 3: Rename tests + fix imports**

Run: `cd orchestrator && git mv test/watchdog-estimate.test.js test/watchdog-estimate.test.ts && git mv test/watchdog-cut.test.js test/watchdog-cut.test.ts && git mv test/watchdog-rewrite.test.js test/watchdog-rewrite.test.ts`
Update the `.js`→`.ts` import specifiers in each.

- [ ] **Step 4: Delete old sources**

Run: `cd orchestrator && git rm src/watchdog/estimate.js src/watchdog/cut.js src/watchdog/rewrite.js`

- [ ] **Step 5: Tests + typecheck**

Run: `cd orchestrator && bun test test/watchdog-estimate.test.ts test/watchdog-cut.test.ts test/watchdog-rewrite.test.ts && bun run typecheck`
Expected: PASS; 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port watchdog leaves to TypeScript"
```

---

### Task 6: Port `registry`

**Files:**
- Create: `src/registry.ts` (from `registry.js`)
- Rename: `test/registry.test.js` → `.ts`
- Delete: `src/registry.js` after green

**Interfaces:**
- Consumes: `StageDescriptor`, `BuildContext`, `BuildResult` from `types.ts`.
- Produces: `REGISTRY: Record<string, StageDescriptor>`.

- [ ] **Step 1: Create `src/registry.ts` — body verbatim, typed**

Import types; annotate `export const REGISTRY: Record<string, StageDescriptor>`. Each `build({ port, upstreamBase, provider, config }: BuildContext): BuildResult`. `process.execPath`/`fileURLToPath` usage unchanged. Keep the `rate-limiter` and both builtin entries exactly as they are.

- [ ] **Step 2: Rename test + fix import**

Run: `cd orchestrator && git mv test/registry.test.js test/registry.test.ts` and update its import to `../src/registry.ts`.

- [ ] **Step 3: Delete old source**

Run: `cd orchestrator && git rm src/registry.js`

- [ ] **Step 4: Tests + typecheck**

Run: `cd orchestrator && bun test test/registry.test.ts && bun run typecheck`
Expected: PASS; 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port registry to TypeScript"
```

---

### Task 7: Port `planner`

**Files:**
- Create: `src/planner.ts` (from `planner.js`)
- Rename: `test/planner.test.js` → `.ts`
- Delete: `src/planner.js` after green

**Interfaces:**
- Consumes: `Config`, `StageDescriptor`, `PlannedStage`, `PlanResult` from `types.ts`; `REGISTRY` from `registry.ts`.
- Produces: `plan(config: Config, registry?: Record<string, StageDescriptor>): PlanResult`.

- [ ] **Step 1: Create `src/planner.ts` — body verbatim, typed**

Annotate `export function plan(config: Config, registry: Record<string, StageDescriptor> = REGISTRY): PlanResult`. Internal locals (`errors: string[]`, `staged`, `chain`) inferred; add explicit annotations only where `strict` complains. Return shapes must match `PlanResult` (both `ok:true`/`ok:false` branches). Import `REGISTRY` from `./registry.ts`.

- [ ] **Step 2: Rename test + fix imports**

Run: `cd orchestrator && git mv test/planner.test.js test/planner.test.ts` and update its `../src/planner.js`/`../src/registry.js` imports to `.ts`.

- [ ] **Step 3: Delete old source**

Run: `cd orchestrator && git rm src/planner.js`

- [ ] **Step 4: Tests + typecheck**

Run: `cd orchestrator && bun test test/planner.test.ts && bun run typecheck`
Expected: PASS; 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port planner to TypeScript"
```

---

### Task 8: Port `supervisor`

**Files:**
- Create: `src/supervisor.ts` (from `supervisor.js`)
- Rename: `test/supervisor.test.js` → `.ts`
- Delete: `src/supervisor.js` after green

**Interfaces:**
- Consumes: `PlannedStage`, `ChainHandle` from `types.ts`.
- Produces: `waitForHealth(url: string, opts?): Promise<void>`; `up(chain: PlannedStage[], opts?: { spawnImpl?; fetchImpl?; healthOpts? }): Promise<ChainHandle>`.

- [ ] **Step 1: Create `src/supervisor.ts` — body verbatim, typed**

Annotate the two exports. Keep the injectable `spawnImpl`/`fetchImpl`/`sleep`/`now` params (typed loosely: `spawnImpl: typeof import('node:child_process').spawn = spawn`, `fetchImpl: typeof fetch = fetch`). The `started` array typed as `Array<{ id: string; port: number; child: import('node:child_process').ChildProcess }>`.

- [ ] **Step 2: Rename test + fix import**

Run: `cd orchestrator && git mv test/supervisor.test.js test/supervisor.test.ts` and update its import.

- [ ] **Step 3: Delete old source**

Run: `cd orchestrator && git rm src/supervisor.js`

- [ ] **Step 4: Tests + typecheck**

Run: `cd orchestrator && bun test test/supervisor.test.ts && bun run typecheck`
Expected: PASS; 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port supervisor to TypeScript"
```

---

### Task 9: Port `launcher` + `router-bootstrap`

**Files:**
- Create: `src/launcher.ts`, `src/router-bootstrap.ts`
- Rename: `test/router-bootstrap.test.js` → `.ts`
- Delete: the two `.js` sources after green

**Interfaces:**
- Produces (launcher): `runClaude(head: { baseUrl: string }, opts: { apiKey?: string; claudeArgs: string[] }): import('node:child_process').ChildProcess`. (Confirm signature against source.)
- Produces (router-bootstrap): `mintToken(routerRoot: string | null): Promise<string>`. (Confirm.)

- [ ] **Step 1: Read both sources for exact exports/signatures**

Run: `cd orchestrator && cat src/launcher.js src/router-bootstrap.js`

- [ ] **Step 2: Create `.ts` twins — bodies verbatim + annotations**

Annotate per the confirmed signatures.

- [ ] **Step 3: Rename the router-bootstrap test + fix import**

Run: `cd orchestrator && git mv test/router-bootstrap.test.js test/router-bootstrap.test.ts` and update its import. (launcher has no dedicated test file — covered indirectly.)

- [ ] **Step 4: Delete old sources**

Run: `cd orchestrator && git rm src/launcher.js src/router-bootstrap.js`

- [ ] **Step 5: Tests + typecheck**

Run: `cd orchestrator && bun test test/router-bootstrap.test.ts && bun run typecheck`
Expected: PASS; 0 errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port launcher + router-bootstrap to TypeScript"
```

---

### Task 10: Port `compact/server` + its bin, smoke-test the stage

**Files:**
- Create: `src/compact/server.ts`, `bin/compact-interceptor.ts`
- Rename: `test/compact-server.test.js` → `.ts`
- Modify: `src/registry.ts` (point `COMPACT_BIN` at `.ts`)
- Delete: `src/compact/server.js`, `bin/compact-interceptor.js` after green

**Interfaces:**
- Consumes: `anthropicToOpenAI`, `openAIMessageToAnthropic`, `anthropicSSEChunks`, `mapStopReason` from `compact/translate.ts`; `isCompactRequest` from `compact/matcher.ts`.
- Produces: `createInterceptor(opts: { port: number; upstream: string; model: string; baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): import('node:http').Server`.

- [ ] **Step 1: Create `src/compact/server.ts` — body verbatim, typed**

Annotate `createInterceptor`. Internal `passthrough`/`serveCompact` param types: `req: import('node:http').IncomingMessage`, `raw: Buffer`, `res: import('node:http').ServerResponse`. Update relative imports to `.ts`.

- [ ] **Step 2: Create `bin/compact-interceptor.ts` — body verbatim from the `.js` bin, shebang `#!/usr/bin/env bun`**

Import from `../src/compact/server.ts`.

- [ ] **Step 3: Point the registry at the `.ts` bin**

In `src/registry.ts`, change `COMPACT_BIN` URL from `../bin/compact-interceptor.js` to `../bin/compact-interceptor.ts`.

- [ ] **Step 4: Rename server test + fix imports**

Run: `cd orchestrator && git mv test/compact-server.test.js test/compact-server.test.ts` and update imports.

- [ ] **Step 5: Delete old files**

Run: `cd orchestrator && git rm src/compact/server.js bin/compact-interceptor.js`

- [ ] **Step 6: Tests + typecheck**

Run: `cd orchestrator && bun test test/compact-server.test.ts && bun run typecheck`
Expected: PASS; 0 errors.

- [ ] **Step 7: Smoke-test the builtin stage spawns under Bun**

Run: `cd orchestrator && PORT=47850 COMPACT_UPSTREAM=https://api.anthropic.com COMPACT_MODEL=x COMPACT_BASE_URL=https://x COMPACT_ENV_KEY=HOME bun bin/compact-interceptor.ts & sleep 1; curl -s 127.0.0.1:47850/health; kill %1`
Expected: `{"status":"ok"}` (uses `HOME` as a present env key so the apiKey guard passes).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port compact server+bin to TypeScript"
```

---

### Task 11: Port `watchdog/server` + its bin, smoke-test the stage

**Files:**
- Create: `src/watchdog/server.ts`, `bin/context-watchdog.ts`
- Rename: `test/watchdog-server.test.js` → `.ts`
- Modify: `src/registry.ts` (point `WATCHDOG_BIN` at `.ts`)
- Delete: `src/watchdog/server.js`, `bin/context-watchdog.js` after green

**Interfaces:**
- Consumes: `isCompactRequest` (compact/matcher.ts), `anthropicToOpenAI` (compact/translate.ts), `estimateTokens`/`planCut`/`summaryKey`/`buildRewrittenBody` (watchdog leaves).
- Produces: `createWatchdog(opts: { port: number; upstream: string; model: string; baseUrl: string; apiKey: string; thresholdTokens: number; tailTurns: number; fetchImpl?: typeof fetch; cache?: Map<string, any> }): import('node:http').Server`.

- [ ] **Step 1: Create `src/watchdog/server.ts` — body verbatim, typed**

Annotate `createWatchdog` per Interfaces. Same `req/raw/res` typing as Task 10. Update relative imports to `.ts`.

- [ ] **Step 2: Create `bin/context-watchdog.ts` — body verbatim, shebang `#!/usr/bin/env bun`, import from `../src/watchdog/server.ts`**

- [ ] **Step 3: Point registry `WATCHDOG_BIN` at `.ts`**

- [ ] **Step 4: Rename server test + fix imports**

Run: `cd orchestrator && git mv test/watchdog-server.test.js test/watchdog-server.test.ts` and update imports.

- [ ] **Step 5: Delete old files**

Run: `cd orchestrator && git rm src/watchdog/server.js bin/context-watchdog.js`

- [ ] **Step 6: Tests + typecheck**

Run: `cd orchestrator && bun test test/watchdog-server.test.ts && bun run typecheck`
Expected: PASS; 0 errors.

- [ ] **Step 7: Smoke-test the stage spawns**

Run: `cd orchestrator && PORT=47851 WATCHDOG_UPSTREAM=https://api.anthropic.com WATCHDOG_MODEL=x WATCHDOG_BASE_URL=https://x WATCHDOG_ENV_KEY=HOME bun bin/context-watchdog.ts & sleep 1; curl -s 127.0.0.1:47851/health; kill %1`
Expected: `{"status":"ok"}`.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port watchdog server+bin to TypeScript"
```

---

### Task 12: Port `ratelimit/server` + its bin, smoke-test the stage

**Files:**
- Create: `src/ratelimit/server.ts`, `bin/rate-limiter.ts`
- Rename: `test/ratelimit-server.test.js` → `.ts`
- Modify: `src/registry.ts` (point `RATELIMIT_BIN` at `.ts`)
- Delete: `src/ratelimit/server.js`, `bin/rate-limiter.js` after green

**Interfaces:**
- Produces: `createGate(opts: { rps: number; burst: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): { acquire(): Promise<void>; penalize(ms: number): void }`; `retryAfterMs(header: string | null | undefined, fallbackMs: number): number`; `createRateLimiter(opts: { port: number; upstream: string; rps?: number; burst?: number; default429CooldownMs?: number; fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> }): import('node:http').Server`.

- [ ] **Step 1: Create `src/ratelimit/server.ts` — body verbatim, typed per Interfaces**

- [ ] **Step 2: Create `bin/rate-limiter.ts` — body verbatim, shebang `#!/usr/bin/env bun`, import from `../src/ratelimit/server.ts`**

- [ ] **Step 3: Point registry `RATELIMIT_BIN` at `.ts`**

- [ ] **Step 4: Rename test + fix imports**

Run: `cd orchestrator && git mv test/ratelimit-server.test.js test/ratelimit-server.test.ts` and update imports.

- [ ] **Step 5: Delete old files**

Run: `cd orchestrator && git rm src/ratelimit/server.js bin/rate-limiter.js`

- [ ] **Step 6: Tests + typecheck**

Run: `cd orchestrator && bun test test/ratelimit-server.test.ts && bun run typecheck`
Expected: PASS (6 tests); 0 errors.

- [ ] **Step 7: Smoke-test the stage spawns**

Run: `cd orchestrator && PORT=47840 RATELIMIT_UPSTREAM=https://api.anthropic.com bun bin/rate-limiter.ts & sleep 1; curl -s 127.0.0.1:47840/health; kill %1`
Expected: `{"status":"ok"}`.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port rate-limiter server+bin to TypeScript"
```

---

### Task 13: Port `cli`

**Files:**
- Create: `src/cli.ts` (from `cli.js`)
- Rename: `test/cli-args.test.js` → `.ts`
- Delete: `src/cli.js` after green

**Interfaces:**
- Consumes: `loadConfig` (config.ts), `plan` (planner.ts), `up` (supervisor.ts), `mintToken` (router-bootstrap.ts), `runClaude` (launcher.ts), `REGISTRY` (registry.ts), `PlanResult`/`ChainHandle` (types.ts).
- Produces: `splitClaudeArgs(argv: string[]): string[]`; `cli(argv: string[]): Promise<number>`.

- [ ] **Step 1: Create `src/cli.ts` — body verbatim, typed**

Annotate `splitClaudeArgs` and `cli`; internal `doRun`/`doUp`/`doDoctor`/`which`/`version`/`routerRootFromChain` return-typed (`Promise<number>`, `boolean`, `string`, `string | null`). Update all `../src/*.js` imports to `.ts`. The `readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)))` stays.

- [ ] **Step 2: Rename test + fix import**

Run: `cd orchestrator && git mv test/cli-args.test.js test/cli-args.test.ts` and update its import to `../src/cli.ts`.

- [ ] **Step 3: Delete old source**

Run: `cd orchestrator && git rm src/cli.js`

- [ ] **Step 4: Tests + typecheck**

Run: `cd orchestrator && bun test test/cli-args.test.ts && bun run typecheck`
Expected: PASS; 0 errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port cli to TypeScript"
```

---

### Task 14: Port entry bin, full-suite gate, README, compile artifact

**Files:**
- Create: `bin/shuba.ts` (from `bin/shuba.js`)
- Delete: `bin/shuba.js`
- Modify: `orchestrator/README.md` (Bun requirement + run/build notes)

**Interfaces:**
- Consumes: `cli` from `src/cli.ts`.

- [ ] **Step 1: Create `bin/shuba.ts`**

```ts
#!/usr/bin/env bun
import { cli } from '../src/cli.ts';
cli(process.argv.slice(2)).then((code) => process.exit(code));
```

- [ ] **Step 2: Delete old entry + confirm no `.js` sources remain**

Run: `cd orchestrator && git rm bin/shuba.js && find src bin -name '*.js' -not -path '*/node_modules/*'`
Expected: the `find` prints nothing (all ported).

- [ ] **Step 3: Full behavior gate**

Run: `cd orchestrator && bun test`
Expected: `70 pass`, `0 fail` — same count as the Task 1 baseline.

- [ ] **Step 4: Full type gate**

Run: `cd orchestrator && bun run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Manual chain smoke — doctor + up**

Run: `cd orchestrator && bun bin/shuba.ts doctor`
Expected: prints `plan: compact-router:47850 → context-watchdog:47851 → headroom:8787 → pxpipe:47821 → rate-limiter:47840` (config-dependent) and per-stage ok/MISSING lines.

- [ ] **Step 6: Compile artifact builds**

Run: `cd orchestrator && bun run build && ./shuba --version`
Expected: prints `0.1.0`. Then `git rm --cached shuba 2>/dev/null; echo 'shuba' >> .gitignore` so the binary is not committed.

- [ ] **Step 7: Update `orchestrator/README.md`**

Add a "Requirements" note: shuba now runs on Bun (`>=1.1`); dev via `bun bin/shuba.ts …`; a standalone binary via `bun run build`. Replace any `node`/`npm test` references with `bun`/`bun test`.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor(orchestrator): port entry bin to Bun+TS; docs + compile artifact"
```

---

## Self-Review

**Spec coverage** (against `2026-07-11-bun-ts-migration-design.md`):
- §2 scope (every src/bin/test file) → Tasks 3–14 cover config, compact/*, watchdog/*, ratelimit/*, registry, planner, supervisor, launcher, router-bootstrap, cli, bins, tests. ✓
- §3 runtime/tooling (Bun, `#!/usr/bin/env bun`, node:test kept, tsc gate, tsconfig, compile) → Task 1 + per-task typecheck + Task 14 compile. ✓
- §4 typing (`types.ts` with StageDescriptor/Config/PlannedStage/PlanResult/ChainHandle) → Task 2. ✓
- §5 migration order (leaves → mid → cli → servers → tests → delete) → Task ordering 3→14. ✓
- §6 acceptance (bun test same count, tsc clean, doctor/up smoke, builtin spawn) → Task 14 steps 3–6 + per-server smoke Tasks 10–12. ✓
- §7 risks (`process.execPath` re-spawn, users without Bun, node:test) → smoke tests Tasks 10–12; README Task 14 step 7; node:test kept (Global Constraints). ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases". Bodies deliberately marked "verbatim from the `.js`" with a Step 1 that reads the source first for the leaf/adapter files whose exact exports must be confirmed — this is a real instruction, not a placeholder.

**Type consistency:** Names used across tasks match `types.ts` (Task 2): `StageDescriptor`, `Config`, `PlannedStage`, `PlanResult`, `ChainHandle`, `BuildContext`, `BuildResult`. Function signatures in Interfaces blocks (`plan`, `up`, `createInterceptor`, `createWatchdog`, `createRateLimiter`, `createGate`, `retryAfterMs`, `splitClaudeArgs`, `cli`) are consistent with the source I read.
