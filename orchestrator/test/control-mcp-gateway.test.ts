import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpGateway } from '../src/control/mcp-gateway.ts';

// A scripted fake MCP server child. Reads newline-delimited JSON-RPC from
// stdin and answers on stdout via the provided `respond` behavior.
function makeFakeChild(behavior: {
  respond: (msg: any, send: (resp: any) => void, child: any) => void;
}): any {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  let killed = false;
  const child: any = {
    stdout,
    stderr,
    stdin: {
      write(str: string) {
        for (const line of str.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const msg = JSON.parse(t);
          if (msg.id === undefined) continue; // notification, no reply
          queueMicrotask(() => {
            if (killed) return;
            behavior.respond(msg, (resp) => stdout.emit('data', Buffer.from(JSON.stringify(resp) + '\n')), child);
          });
        }
        return true;
      },
    },
    on(event: string, cb: (...a: any[]) => void) {
      emitter.on(event, cb);
    },
    kill() {
      if (killed) return;
      killed = true;
      queueMicrotask(() => emitter.emit('exit', 0, null));
    },
    get killed() {
      return killed;
    },
  };
  return child;
}

function defaultBehavior(opts: { tools?: any[]; hangOnCall?: boolean; crashAfterCall?: boolean } = {}) {
  return {
    respond(msg: any, send: (resp: any) => void, child: any) {
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'echo', version: '1' } } });
      } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: opts.tools ?? [{ name: 'ping', description: 'p' }] } });
      } else if (msg.method === 'tools/call') {
        if (opts.hangOnCall) return; // never respond -> caller must time out
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong:' + JSON.stringify(msg.params?.arguments ?? {}) }] } });
        if (opts.crashAfterCall) child.kill();
      }
    },
  };
}

// Build a store dir with one enabled `mcp` entry and its config file.
function makeStore(id = 'echo', name = 'Echo'): string {
  const dir = mkdtempSync(join(tmpdir(), 'shuba-gw-'));
  const manifest = [
    { id, type: 'mcp', name, description: 'test', sourcePath: '', enabled: true, importedAt: '' },
    { id: 'a-skill', type: 'skill', name: 'S', enabled: true },
  ];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  writeFileSync(join(dir, 'mcp', `${id}.json`), JSON.stringify({ command: 'fake', args: [] }));
  return dir;
}

function gatewayWith(behaviors: ReturnType<typeof defaultBehavior>[], storeDir: string) {
  let spawnCount = 0;
  const spawnImpl: any = () => {
    const behavior = behaviors[Math.min(spawnCount, behaviors.length - 1)];
    spawnCount += 1;
    return makeFakeChild(behavior);
  };
  const gw = createMcpGateway({ storeDir, spawnImpl });
  return {
    gw,
    get spawnCount() {
      return spawnCount;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

test('gateway lists only enabled mcp entries, lazily (not running before use)', async () => {
  const store = makeStore();
  const { gw } = gatewayWith([defaultBehavior()], store);
  const servers = gw.listServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, 'echo');
  assert.equal(servers[0].name, 'Echo');
  assert.equal(servers[0].running, false);
  assert.equal(servers[0].toolCount, undefined);
  gw.dispose();
});

test('gateway handshake + tools/list, then reports running with toolCount', async () => {
  const store = makeStore();
  const w = gatewayWith([defaultBehavior({ tools: [{ name: 'ping' }, { name: 'pong' }] })], store);
  const gw = w.gw;
  const tools = await gw.listTools('echo');
  assert.ok(Array.isArray(tools));
  assert.deepEqual((tools as any[]).map((t) => t.name), ['ping', 'pong']);
  assert.equal(w.spawnCount, 1);
  const servers = gw.listServers();
  assert.equal(servers[0].running, true);
  assert.equal(servers[0].toolCount, 2);
  gw.dispose();
});

test('gateway proxies tools/call and returns the server result', async () => {
  const store = makeStore();
  const { gw } = gatewayWith([defaultBehavior()], store);
  const res: any = await gw.callTool('echo', 'ping', { x: 1 });
  assert.ok(!('error' in res));
  assert.equal(res.content[0].text, 'pong:{"x":1}');
  gw.dispose();
});

test('gateway keeps one child alive across calls (no respawn)', async () => {
  const store = makeStore();
  const w = gatewayWith([defaultBehavior()], store);
  await w.gw.listTools('echo');
  await w.gw.callTool('echo', 'ping', {});
  await w.gw.callTool('echo', 'ping', {});
  assert.equal(w.spawnCount, 1);
  w.gw.dispose();
});

test('gateway returns { error } on tools/call timeout instead of hanging', async () => {
  const store = makeStore();
  const { gw } = gatewayWith([defaultBehavior({ hangOnCall: true })], store);
  const res: any = await gw.callTool('echo', 'ping', {}, 40);
  assert.ok(res.error);
  assert.match(res.error, /timed out/);
  gw.dispose();
});

test('gateway respawns after a crash on the next call', async () => {
  const store = makeStore();
  const w = gatewayWith([defaultBehavior({ crashAfterCall: true }), defaultBehavior()], store);
  const first: any = await w.gw.callTool('echo', 'ping', {});
  assert.match(JSON.stringify(first), /pong/);
  await tick(); // let the crash (exit) propagate
  assert.equal(w.gw.listServers()[0].running, false);
  const second: any = await w.gw.callTool('echo', 'ping', {});
  assert.match(JSON.stringify(second), /pong/);
  assert.equal(w.spawnCount, 2);
  w.gw.dispose();
});

test('gateway reports { error } for an unknown or disabled server', async () => {
  const store = makeStore();
  const { gw } = gatewayWith([defaultBehavior()], store);
  const list: any = await gw.listTools('nope');
  assert.match(list.error, /unknown or disabled/);
  const call: any = await gw.callTool('nope', 'ping', {});
  assert.match(call.error, /unknown or disabled/);
  gw.dispose();
});
