import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import type { DelegateInput, JobStatus } from './types.ts';

type Engine = {
  delegate(input: DelegateInput): Promise<{ job_id: string; harness_chosen: string; model_chosen: string }>;
  status(id: string): unknown;
  result(id: string): unknown;
  harnessList(): unknown;
  listJobs(): unknown;
};

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

export function createControlHttp(engine: Engine, opts?: { staticDir?: string }): Server {
  const staticDir = opts?.staticDir;

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

    if (method === 'GET' && staticDir) {
      const served = await tryServeStatic(staticDir, pathname, res);
      if (served) return;
    }

    sendJson(res, 404, { error: `not found: ${method} ${pathname}` });
  }

  server.on('upgrade', (req, socket) => {
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
