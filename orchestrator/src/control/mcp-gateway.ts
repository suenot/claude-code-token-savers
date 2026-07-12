import { spawn as defaultSpawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// shuba-control acts as an MCP gateway: Claude Code connects to shuba-control
// alone, and every MCP server imported out of Claude Code (into the
// ~/.shuba/capabilities store) stays reachable through this single
// connection. Underlying servers are spawned lazily on first use, kept alive,
// and multiplexed here.

// One imported server's config, the standard .mcp.json server shape.
export type ServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

// Entry in the capabilities store manifest (only `type: 'mcp'` entries matter
// to the gateway; the rest are skills/agents/plugins other subsystems own).
type ManifestEntry = {
  id: string;
  type: 'skill' | 'agent' | 'mcp' | 'plugin';
  name: string;
  description?: string;
  sourcePath?: string;
  enabled: boolean;
  importedAt?: string;
};

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type ServerInfo = {
  id: string;
  name: string;
  running: boolean;
  toolCount?: number;
};

export type ToolCallResult = unknown | { error: string };

export type McpGateway = {
  listServers(): ServerInfo[];
  listTools(serverId: string): Promise<McpToolDef[] | { error: string }>;
  callTool(serverId: string, toolName: string, args: unknown, timeoutMs?: number): Promise<ToolCallResult>;
  dispose(): void;
};

type SpawnImpl = typeof import('node:child_process').spawn;

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

// A live connection to one underlying MCP server over stdio. MCP stdio framing
// is newline-delimited JSON (one JSON-RPC message per line, no Content-Length
// headers), per the spec.
class ChildConn {
  private child: ReturnType<SpawnImpl> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private initPromise: Promise<void> | null = null;
  private toolsCache: McpToolDef[] | null = null;
  private disposed = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly spawnImpl: SpawnImpl,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  get cachedToolCount(): number | undefined {
    return this.toolsCache?.length;
  }

  // Spawn + handshake once; memoized so concurrent callers share one attempt.
  // A crashed child clears the memo so the next call respawns.
  private ensureStarted(): Promise<void> {
    if (this.child && this.initPromise) return this.initPromise;
    this.initPromise = this.startAndHandshake().catch((err) => {
      this.teardown(err instanceof Error ? err : new Error(String(err)));
      throw err;
    });
    return this.initPromise;
  }

  private async startAndHandshake(): Promise<void> {
    const child = this.spawnImpl(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.config.env ?? {}) },
    });
    this.child = child;

    child.on('error', (err: Error) => this.teardown(err));
    child.on('exit', () => this.teardown(new Error('server process exited')));
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    // Drain stderr so a chatty server can't fill the pipe and block.
    child.stderr?.on('data', () => {});

    await withTimeout(
      this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'shuba-control-gateway', version: '0.1.0' },
      }),
      HANDSHAKE_TIMEOUT_MS,
      'initialize',
    );
    this.notify('notifications/initialized', {});
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON log noise on stdout
      }
      if (msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const m = msg.error?.message ?? 'rpc error';
          p.reject(new Error(typeof m === 'string' ? m : JSON.stringify(m)));
        } else {
          p.resolve(msg.result);
        }
      }
      // notifications / responses to notifications are ignored
    }
  }

  private request(method: string, params: unknown, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child || !child.stdin) return Promise.reject(new Error('server not running'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      // best-effort; a dead pipe surfaces on the next request
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.ensureStarted();
    if (this.toolsCache) return this.toolsCache;
    const result: any = await withTimeout(this.request('tools/list', {}), HANDSHAKE_TIMEOUT_MS, 'tools/list');
    const tools: McpToolDef[] = Array.isArray(result?.tools) ? result.tools : [];
    this.toolsCache = tools;
    return tools;
  }

  async callTool(name: string, args: unknown, timeoutMs: number): Promise<unknown> {
    await this.ensureStarted();
    return withTimeout(
      this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs),
      timeoutMs,
      `tools/call ${name}`,
    );
  }

  // Reject everything in flight and drop the child so the next call respawns.
  private teardown(err: Error): void {
    const child = this.child;
    this.child = null;
    this.initPromise = null;
    this.toolsCache = null;
    this.buffer = '';
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (child) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown(new Error('gateway disposed'));
  }
}

// Race any awaited work against a timeout so a hung server never wedges the
// gateway. The underlying request also self-cleans on its own timer; this is a
// belt-and-suspenders bound for the whole operation (handshake + request).
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function errorResult(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

export function createMcpGateway(opts: { storeDir?: string; spawnImpl?: SpawnImpl }): McpGateway {
  const storeDir = opts.storeDir ?? join(homedir(), '.shuba', 'capabilities');
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  const conns = new Map<string, ChildConn>();

  // Re-read the manifest on every call so console toggles take effect live.
  // Returns only enabled `mcp` entries.
  function readManifest(): ManifestEntry[] {
    const p = join(storeDir, 'manifest.json');
    if (!existsSync(p)) return [];
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e): e is ManifestEntry => e && e.type === 'mcp' && e.enabled === true);
    } catch {
      return [];
    }
  }

  function readConfig(id: string): ServerConfig | null {
    const p = join(storeDir, 'mcp', `${id}.json`);
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      if (parsed && typeof parsed.command === 'string') return parsed as ServerConfig;
      return null;
    } catch {
      return null;
    }
  }

  // Reconcile: kill children whose entry is no longer enabled/present, so a
  // server toggled off in the console doesn't linger.
  function reconcile(enabledIds: Set<string>): void {
    for (const [id, conn] of conns) {
      if (!enabledIds.has(id)) {
        conn.dispose();
        conns.delete(id);
      }
    }
  }

  function connFor(id: string): ChildConn | { error: string } {
    const entry = readManifest().find((e) => e.id === id);
    if (!entry) return { error: `unknown or disabled MCP server: ${id}` };
    const config = readConfig(id);
    if (!config) return { error: `no config for MCP server: ${id}` };
    let conn = conns.get(id);
    if (!conn) {
      conn = new ChildConn(config, spawnImpl);
      conns.set(id, conn);
    }
    return conn;
  }

  return {
    listServers() {
      const entries = readManifest();
      reconcile(new Set(entries.map((e) => e.id)));
      return entries.map((e) => {
        const conn = conns.get(e.id);
        return {
          id: e.id,
          name: e.name,
          running: conn?.running ?? false,
          toolCount: conn?.cachedToolCount,
        };
      });
    },

    async listTools(serverId) {
      const conn = connFor(serverId);
      if ('error' in conn) return conn;
      try {
        return await conn.listTools();
      } catch (err) {
        return errorResult(err);
      }
    },

    async callTool(serverId, toolName, args, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
      const conn = connFor(serverId);
      if ('error' in conn) return conn;
      try {
        return await conn.callTool(toolName, args, timeoutMs);
      } catch (err) {
        return errorResult(err);
      }
    },

    dispose() {
      for (const [, conn] of conns) conn.dispose();
      conns.clear();
    },
  };
}
