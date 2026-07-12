import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '../src/capabilities/scanner.ts';

// Build a throwaway Claude Code layout: a claudeRoot (~/.claude equivalent), a
// sibling ~/.claude.json, and a project cwd. Everything is under one temp dir
// so the real home is never touched.
function withFixture(fn: (paths: { claudeRoot: string; projectCwd: string }) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'shuba-cap-scan-'));
  try {
    fn({ claudeRoot: join(base, '.claude'), projectCwd: join(base, 'project') });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

test('scan finds skills with frontmatter name/description', () => {
  withFixture(({ claudeRoot }) => {
    writeFile(join(claudeRoot, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: does foo\n---\nbody');
    const skills = scan(claudeRoot).filter((c) => c.type === 'skill');
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.id, 'skill:foo');
    assert.equal(skills[0]!.name, 'foo');
    assert.equal(skills[0]!.description, 'does foo');
    assert.equal(skills[0]!.sourcePath, join(claudeRoot, 'skills', 'foo'));
  });
});

test('scan finds user and project agents, project shape included', () => {
  withFixture(({ claudeRoot, projectCwd }) => {
    writeFile(join(claudeRoot, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: reviews\n---\n');
    writeFile(join(projectCwd, '.claude', 'agents', 'local.md'), '---\nname: local\ndescription: local agent\n---\n');
    const agents = scan(claudeRoot, projectCwd).filter((c) => c.type === 'agent');
    const ids = agents.map((a) => a.id).sort();
    assert.deepEqual(ids, ['agent:local', 'agent:reviewer']);
  });
});

test('scan finds mcp servers from project .mcp.json and ~/.claude.json (top-level + per-project)', () => {
  withFixture(({ claudeRoot, projectCwd }) => {
    writeFile(join(projectCwd, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'p' } } }));
    // ~/.claude.json sits one level up from claudeRoot.
    writeFile(join(claudeRoot, '..', '.claude.json'), JSON.stringify({
      mcpServers: { global: { command: 'g' } },
      projects: { [projectCwd]: { mcpServers: { perproj: { command: 'x' } } } },
    }));
    const mcp = scan(claudeRoot, projectCwd).filter((c) => c.type === 'mcp');
    const ids = mcp.map((m) => m.id).sort();
    assert.deepEqual(ids, ['mcp:global', 'mcp:perproj', 'mcp:proj']);
    const proj = mcp.find((m) => m.id === 'mcp:proj')!;
    assert.deepEqual(proj.mcp?.config, { command: 'p' });
    assert.equal(proj.mcp?.serverKey, 'proj');
  });
});

test('scan finds plugins and attributes their cached skill/agent files', () => {
  withFixture(({ claudeRoot }) => {
    const installPath = join(claudeRoot, 'plugins', 'cache', 'mkt', 'myplugin', '1.0.0');
    writeFile(join(installPath, 'skills', 's1', 'SKILL.md'), '---\nname: s1\n---\n');
    writeFile(join(installPath, 'agents', 'a1.md'), '---\nname: a1\n---\n');
    writeFile(join(claudeRoot, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'myplugin@mkt': [{ scope: 'user', installPath }] },
    }));
    const plugins = scan(claudeRoot).filter((c) => c.type === 'plugin');
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]!.id, 'plugin:myplugin@mkt');
    assert.equal(plugins[0]!.name, 'myplugin');
    assert.equal(plugins[0]!.plugin?.cachedFiles.length, 2);
  });
});

test('scan skips plugins already flipped enabled:false', () => {
  withFixture(({ claudeRoot }) => {
    writeFile(join(claudeRoot, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'gone@mkt': [{ scope: 'user', installPath: '/x', enabled: false }] },
    }));
    const plugins = scan(claudeRoot).filter((c) => c.type === 'plugin');
    assert.equal(plugins.length, 0);
  });
});

test('scan tolerates a completely empty claude root', () => {
  withFixture(({ claudeRoot, projectCwd }) => {
    assert.deepEqual(scan(claudeRoot, projectCwd), []);
  });
});
