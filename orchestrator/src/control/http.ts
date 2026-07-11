import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import type { DelegateInput, JobStatus } from './types.ts';
import { isStageEnabled, persistToggle, runtimePath, setToggle } from './toggles.ts';
import { configPath } from '../config.ts';

type Engine = {
  delegate(input: DelegateInput): Promise<{ job_id: string; harness_chosen: string; model_chosen: string }>;
  status(id: string): unknown;
  result(id: string): unknown;
  harnessList(): unknown;
  listJobs(): unknown;
};

type Graph = {
  status(): unknown;
  query(query: string): unknown;
};

type Collector = {
  chain(): Promise<unknown>;
  stats(): Promise<unknown>;
  recentRequests(limit?: number): Promise<unknown>;
  hopLog(limit?: number): Promise<unknown>;
};

const SECRET_KEY_RE = /api[_-]?key|secret|token|password|passphrase|credential|bearer|private[_-]?key/i;

// redactSecrets recursively walks a value and drops any object key whose
// name matches SECRET_KEY_RE (case-insensitive). Used to strip credentials
// out of the loaded config before serving it over GET /api/config. Arrays
// are walked element-wise; primitives pass through unchanged.
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) continue;
      out[key] = redactSecrets(val);
    }
    return out;
  }
  return value;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Returns true when `host` (a Host header value, optionally with :port) refers
// to loopback (127.0.0.1, localhost, or [::1]). Used to guard against
// DNS-rebinding (Host header) and CSWSH (Origin header) attacks against the
// control server, which is only ever meant to be reached from the local
// machine.
export function isLoopbackHost(host?: string): boolean {
  if (!host) return false;
  let hostname = host.trim();
  if (hostname.length === 0) return false;
  // Strip a bracketed IPv6 literal, e.g. "[::1]:8080" -> "::1"
  const bracketMatch = hostname.match(/^\[([^\]]+)\]/);
  if (bracketMatch) {
    hostname = bracketMatch[1]!;
  } else {
    // Strip a trailing :port, but only if there's exactly one colon (avoid
    // mangling bare IPv6 literals without brackets).
    const colonCount = (hostname.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      hostname = hostname.slice(0, hostname.indexOf(':'));
    }
  }
  hostname = hostname.toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// Returns true when `origin` (a raw Origin header value, e.g.
// "http://evil.com") resolves to a loopback host. Used to reject
// cross-origin HTTP requests (CSRF), mirroring the WS upgrade Origin guard.
function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// Known shuba chain stages exposed via GET/POST /api/toggles. Our own stages
// (compact-router, context-watchdog, rate-limiter) honor the toggle live, on
// the next proxied request — no restart needed. pxpipe/headroom are
// third-party stages wired into the process tree at startup, so flipping
// their toggle only takes effect after a restart.
const KNOWN_STAGES = ['compact-router', 'context-watchdog', 'headroom', 'pxpipe', 'rate-limiter'] as const;
type KnownStage = (typeof KNOWN_STAGES)[number];
const LIVE_STAGES = new Set<string>(['compact-router', 'context-watchdog', 'rate-limiter']);

function isKnownStage(value: unknown): value is KnownStage {
  return typeof value === 'string' && (KNOWN_STAGES as readonly string[]).includes(value);
}

function togglesView(togglesPath: string): Array<{ id: string; enabled: boolean; live: boolean; restartRequired: boolean }> {
  return KNOWN_STAGES.map((id) => {
    const live = LIVE_STAGES.has(id);
    return { id, enabled: isStageEnabled(id, togglesPath), live, restartRequired: !live };
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createControlHttp(
  engine: Engine,
  opts?: {
    staticDir?: string;
    graph?: Graph;
    collector?: Collector;
    config?: unknown;
    togglesPath?: string;
    chainPath?: string;
  },
): Server {
  const staticDir = opts?.staticDir;
  const graph = opts?.graph;
  const collector = opts?.collector;
  const config = opts?.config;
  const togglesPath = opts?.togglesPath ?? runtimePath();
  const chainPath = opts?.chainPath ?? configPath();

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';

    // Guard against DNS-rebinding: reject requests whose Host header does not
    // point at loopback, before doing anything else.
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden: invalid host' });
      return;
    }

    // CSRF guard: reject cross-origin requests before routing. A browser tab
    // on an attacker-controlled origin can send a same-Host, cross-origin
    // "simple request" (e.g. POST with Content-Type: text/plain) that skips
    // CORS preflight entirely — the Host guard above doesn't stop this since
    // the attacker targets 127.0.0.1 directly. Non-browser clients (CLI,
    // same-origin SPA fetch, tests) may omit Origin entirely — that's
    // allowed.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !isLoopbackOrigin(origin)) {
      sendJson(res, 403, { error: 'forbidden: invalid origin' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const segments = pathname.split('/').filter(Boolean);

    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && pathname === '/api/harnesses') {
      sendJson(res, 200, engine.harnessList());
      return;
    }

    if (method === 'GET' && pathname === '/api/jobs') {
      sendJson(res, 200, engine.listJobs());
      return;
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'jobs' && segments.length === 4 && segments[3] === 'result') {
      const id = segments[2]!;
      sendJson(res, 200, engine.result(id));
      return;
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'jobs' && segments.length === 3) {
      const id = segments[2]!;
      sendJson(res, 200, engine.status(id));
      return;
    }

    if (method === 'POST' && pathname === '/api/delegate') {
      // Require an explicit JSON content-type. This forces cross-origin JS
      // to trigger a CORS preflight (rather than sending a text/plain
      // "simple request" that bypasses it), closing the CSRF bypass path.
      const contentType = req.headers['content-type'];
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { error: 'content-type must be application/json' });
        return;
      }
      const raw = await readBody(req);
      let body: DelegateInput;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const result = await engine.delegate(body);
      sendJson(res, 200, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/graph') {
      if (!graph) {
        sendJson(res, 404, { error: 'graph not enabled' });
        return;
      }
      sendJson(res, 200, graph.status());
      return;
    }

    if (method === 'POST' && pathname === '/api/graph/query') {
      if (!graph) {
        sendJson(res, 404, { error: 'graph not enabled' });
        return;
      }
      // Same JSON-content-type + Origin guard pattern as /api/delegate.
      const contentType = req.headers['content-type'];
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { error: 'content-type must be application/json' });
        return;
      }
      const raw = await readBody(req);
      let body: { query?: string };
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const result = graph.query(body.query ?? '');
      sendJson(res, 200, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/chain') {
      if (!collector) {
        sendJson(res, 404, { error: 'collector not enabled' });
        return;
      }
      sendJson(res, 200, await collector.chain());
      return;
    }

    if (method === 'GET' && pathname === '/api/stats') {
      if (!collector) {
        sendJson(res, 404, { error: 'collector not enabled' });
        return;
      }
      sendJson(res, 200, await collector.stats());
      return;
    }

    if (method === 'GET' && pathname === '/api/requests') {
      if (!collector) {
        sendJson(res, 404, { error: 'collector not enabled' });
        return;
      }
      const limitParam = url.searchParams.get('limit');
      const parsedLimit = limitParam !== null ? Number.parseInt(limitParam, 10) : NaN;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
      sendJson(res, 200, await collector.hopLog(limit));
      return;
    }

    if (method === 'GET' && pathname === '/api/config') {
      sendJson(res, 200, redactSecrets(config ?? {}));
      return;
    }

    if (method === 'GET' && pathname === '/api/toggles') {
      sendJson(res, 200, togglesView(togglesPath));
      return;
    }

    if (method === 'POST' && pathname === '/api/toggles') {
      // Same JSON-content-type + Origin guard pattern as /api/delegate.
      const contentType = req.headers['content-type'];
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        sendJson(res, 415, { error: 'content-type must be application/json' });
        return;
      }
      const raw = await readBody(req);
      let body: { stage?: unknown; enabled?: unknown };
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      if (!isKnownStage(body.stage) || typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'stage (known stage id) and enabled (boolean) are required' });
        return;
      }
      const stage = body.stage;
      const enabled = body.enabled;
      // Live effect for our own stages (they read runtime.json per request);
      // persisted to chain.json regardless, so a restart also picks it up.
      setToggle(stage, enabled, togglesPath);
      persistToggle(stage, enabled, chainPath);
      sendJson(res, 200, togglesView(togglesPath));
      return;
    }

    if (method === 'GET' && staticDir) {
      const served = await tryServeStatic(staticDir, pathname, res);
      if (served) return;
      // SPA fallback: any non-/api GET route that doesn't match a static
      // asset falls back to index.html (client-side router owns it). Known
      // /api/* routes already returned above; an *unmatched* /api/* path
      // (segments[0] === 'api') is a genuine 404, not a SPA route.
      if (segments[0] !== 'api') {
        const servedIndex = await tryServeStatic(staticDir, '/', res);
        if (servedIndex) return;
      }
    }

    sendJson(res, 404, { error: `not found: ${method} ${pathname}` });
  }

  server.on('upgrade', (req, socket) => {
    // DNS-rebinding guard: reject upgrades whose Host header isn't loopback.
    if (!isLoopbackHost(req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // CSWSH guard: a browser tab on an attacker-controlled origin can still
    // point a WebSocket at ws://127.0.0.1:<port>/... (the Host header alone
    // doesn't protect against this, since the attacker's page controls the
    // URL, not the Host). Reject any upgrade carrying a non-loopback Origin.
    // Non-browser clients (CLI, native WS, some fetch-based SPA clients) may
    // omit Origin entirely — that's allowed.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !isLoopbackOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    // /api/stream/logs/:id
    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'stream' && segments[2] === 'logs') {
      const id = segments[3]!;
      handleLogStreamUpgrade(req, socket, id, engine);
      return;
    }
    socket.destroy();
  });

  return server;
}

async function tryServeStatic(staticDir: string, pathname: string, res: ServerResponse): Promise<boolean> {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safeRel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(staticDir, safeRel);
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// Minimal WS upgrade for /api/stream/logs/:id: completes the handshake, then
// polls engine.status(id).tail every 500ms and pushes deltas as text frames.
// Spec 3 (console) is expected to refine framing/channels; this keeps scope
// small per Task 8.
function handleLogStreamUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, id: string, engine: Engine): void {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let lastTail = '';
  const timer = setInterval(() => {
    if (socket.destroyed) {
      clearInterval(timer);
      return;
    }
    let tail = '';
    try {
      const status = engine.status(id) as { tail?: string } | { error: string };
      tail = 'tail' in status && typeof status.tail === 'string' ? status.tail : '';
    } catch {
      tail = '';
    }
    if (tail && tail !== lastTail) {
      const delta = tail.startsWith(lastTail) ? tail.slice(lastTail.length) : tail;
      lastTail = tail;
      writeTextFrame(socket, delta);
    }
  }, 500);

  socket.on('close', () => clearInterval(timer));
  socket.on('error', () => clearInterval(timer));
}

function writeTextFrame(socket: import('node:stream').Duplex, text: string): void {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}
