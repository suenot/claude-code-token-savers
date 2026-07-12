import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCapabilities } from '../src/capabilities/takeover.ts';

// A full temp world: storeRoot (~/.shuba/capabilities), claudeRoot (~/.claude),
// its sibling ~/.claude.json, and a project cwd. Nothing here escapes the temp
// dir, so the developer's real config is never at risk.
type World = { base: string; storeRoot: string; claudeRoot: string; projectCwd: string };

function withWorld(fn: (w: World) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'shuba-cap-take-'));
  try {
    fn({
      base,
      storeRoot: join(base, 'store'),
      claudeRoot: join(base, '.claude'),
      projectCwd: join(base, 'project'),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function make(w: World) {
  return createCapabilities({ storeRoot: w.storeRoot, claudeRoot: w.claudeRoot, projectCwd: w.projectCwd });
}

test('importOne(skill) copies into store, records manifest, moves source out of Claude', () => {
  withWorld((w) => {
    writeFile(join(w.claudeRoot, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: d\n---\nbody');
    const cap = make(w);
    const entry = cap.importOne('skill:foo');
    assert.equal(entry?.id, 'skill:foo');
    assert.equal(entry?.enabled, true);
    // copied into store
    assert.ok(existsSync(join(w.storeRoot, 'skills', 'foo', 'SKILL.md')));
    // removed from Claude
    assert.ok(!existsSync(join(w.claudeRoot, 'skills', 'foo')));
    // manifest has it
    assert.equal(cap.list && (cap.list() as any).manifest.length, 1);
  });
});

test('import is idempotent — a second import of the same id is a no-op', () => {
  withWorld((w) => {
    writeFile(join(w.claudeRoot, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n');
    const cap = make(w);
    cap.importOne('skill:foo');
    const again = cap.importOne('skill:foo');
    assert.equal(again?.id, 'skill:foo');
    assert.equal(cap.store.read().length, 1);
  });
});

test('eject(skill) restores the source byte-identical and drops the manifest entry', () => {
  withWorld((w) => {
    const original = '---\nname: foo\ndescription: d\n---\nexact bytes here\n';
    const src = join(w.claudeRoot, 'skills', 'foo', 'SKILL.md');
    writeFile(src, original);
    const cap = make(w);
    cap.importOne('skill:foo');
    assert.ok(!existsSync(src));
    assert.equal(cap.eject('skill:foo'), true);
    assert.ok(existsSync(src));
    assert.equal(readFileSync(src, 'utf8'), original);
    assert.equal(cap.store.read().length, 0);
  });
});

test('eject(agent) restores the .md byte-identical', () => {
  withWorld((w) => {
    const original = '---\nname: rev\ndescription: d\n---\nagent body\n';
    const src = join(w.claudeRoot, 'agents', 'rev.md');
    writeFile(src, original);
    const cap = make(w);
    cap.importOne('agent:rev');
    assert.ok(!existsSync(src));
    cap.eject('agent:rev');
    assert.equal(readFileSync(src, 'utf8'), original);
  });
});

test('mcp import rewrites the source JSON without the key, preserves other keys, writes .bak', () => {
  withWorld((w) => {
    const mcpPath = join(w.projectCwd, '.mcp.json');
    writeFile(mcpPath, JSON.stringify({ mcpServers: { keep: { command: 'k' }, drop: { command: 'd' } } }, null, 2));
    const cap = make(w);
    cap.importOne('mcp:drop');
    const rewritten = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.deepEqual(Object.keys(rewritten.mcpServers), ['keep']);
    // .bak snapshot exists with the original content
    assert.ok(existsSync(`${mcpPath}.bak`));
    assert.ok(JSON.parse(readFileSync(`${mcpPath}.bak`, 'utf8')).mcpServers.drop);
    // config copied into store
    assert.deepEqual(JSON.parse(readFileSync(join(w.storeRoot, 'mcp', 'drop.json'), 'utf8')), { command: 'd' });
  });
});

test('eject(mcp) re-inserts the server key back into the config file', () => {
  withWorld((w) => {
    const mcpPath = join(w.projectCwd, '.mcp.json');
    writeFile(mcpPath, JSON.stringify({ mcpServers: { keep: { command: 'k' }, drop: { command: 'd' } } }));
    const cap = make(w);
    cap.importOne('mcp:drop');
    cap.eject('mcp:drop');
    const doc = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.deepEqual(doc.mcpServers.drop, { command: 'd' });
    assert.deepEqual(doc.mcpServers.keep, { command: 'k' });
  });
});

test('mcp import from ~/.claude.json per-project block strips only that key', () => {
  withWorld((w) => {
    const claudeJson = join(w.claudeRoot, '..', '.claude.json');
    writeFile(claudeJson, JSON.stringify({
      mcpServers: { top: { command: 't' } },
      projects: { [w.projectCwd]: { mcpServers: { perproj: { command: 'p' } }, other: 'keep' } },
    }));
    const cap = make(w);
    cap.importOne('mcp:perproj');
    const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.deepEqual(doc.projects[w.projectCwd].mcpServers, {});
    assert.equal(doc.projects[w.projectCwd].other, 'keep');
    assert.deepEqual(doc.mcpServers, { top: { command: 't' } });
    // eject puts it back in the per-project block
    cap.eject('mcp:perproj');
    const back = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.deepEqual(back.projects[w.projectCwd].mcpServers.perproj, { command: 'p' });
  });
});

test('plugin import disables it in installed_plugins.json (not uninstall) and eject re-enables', () => {
  withWorld((w) => {
    const installPath = join(w.claudeRoot, 'plugins', 'cache', 'mkt', 'p', '1.0.0');
    writeFile(join(installPath, 'skills', 's', 'SKILL.md'), '---\nname: s\n---\n');
    const manifestPath = join(w.claudeRoot, 'plugins', 'installed_plugins.json');
    writeFile(manifestPath, JSON.stringify({ version: 2, plugins: { 'p@mkt': [{ scope: 'user', installPath }] } }));
    const cap = make(w);
    cap.importOne('plugin:p@mkt');
    let doc = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(doc.plugins['p@mkt'][0].enabled, false);
    // cached files copied into store
    assert.ok(existsSync(join(w.storeRoot, 'plugins', 'plugin_p_mkt', 'files', 'SKILL.md')));
    // eject clears the disable flag
    cap.eject('plugin:p@mkt');
    doc = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal('enabled' in doc.plugins['p@mkt'][0], false);
  });
});

test('verify reports clean after a full importAll and lists leftovers otherwise', () => {
  withWorld((w) => {
    writeFile(join(w.claudeRoot, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n');
    writeFile(join(w.claudeRoot, 'agents', 'bar.md'), '---\nname: bar\n---\n');
    const cap = make(w);
    assert.equal(cap.verify().clean, true); // nothing imported yet -> no leftovers
    cap.importAll();
    const v = cap.verify();
    assert.equal(v.clean, true);
    assert.equal(v.leftovers.length, 0);
    // Simulate a strip that didn't take: put the skill file back on disk.
    writeFile(join(w.claudeRoot, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n');
    const v2 = cap.verify();
    assert.equal(v2.clean, false);
    assert.deepEqual(v2.leftovers.map((l) => l.id), ['skill:foo']);
  });
});

test('importAll imports everything scanned and is safe to re-run', () => {
  withWorld((w) => {
    writeFile(join(w.claudeRoot, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n');
    writeFile(join(w.projectCwd, '.mcp.json'), JSON.stringify({ mcpServers: { m: { command: 'm' } } }));
    const cap = make(w);
    const first = cap.importAll();
    assert.equal(first.length, 2);
    const second = cap.importAll();
    assert.equal(second.length, 0);
  });
});
