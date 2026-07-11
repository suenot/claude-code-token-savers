import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disableClientGraphifyHook } from '../src/control/graphify-hook.ts';

function settingsWithGraphifyHook() {
  return {
    someTopLevel: true,
    hooks: {
      SessionStart: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: '/path/to/graphify/build-and-watch.sh' }],
        },
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: '/path/to/unrelated-hook.sh' }],
        },
      ],
    },
  };
}

describe('control graphify-hook', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shuba-graphify-hook-'));
    settingsPath = join(dir, 'settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('removes graphify SessionStart hook, keeps unrelated one, restore() reinstates exactly', () => {
    const original = settingsWithGraphifyHook();
    const originalRaw = JSON.stringify(original, null, 2) + '\n';
    writeFileSync(settingsPath, originalRaw);

    const result = disableClientGraphifyHook(settingsPath);
    expect(result.disabled).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.someTopLevel).toBe(true);
    expect(written.hooks.SessionStart).toEqual([
      {
        matcher: 'startup',
        hooks: [{ type: 'command', command: '/path/to/unrelated-hook.sh' }],
      },
    ]);

    result.restore();
    const restoredRaw = readFileSync(settingsPath, 'utf8');
    expect(restoredRaw).toBe(originalRaw);
    expect(JSON.parse(restoredRaw)).toEqual(original);
  });

  test('preserves sibling command within same matcher group (only removes graphify entries)', () => {
    const original = {
      hooks: {
        SessionStart: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: '/path/graphify/build-and-watch.sh' },
              { type: 'command', command: '/path/other-tool.sh' },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2) + '\n');

    const result = disableClientGraphifyHook(settingsPath);
    expect(result.disabled).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.SessionStart).toEqual([
      {
        matcher: '',
        hooks: [{ type: 'command', command: '/path/other-tool.sh' }],
      },
    ]);
  });

  test('absent file → {disabled:false}, no throw, no file created', () => {
    expect(existsSync(settingsPath)).toBe(false);
    const result = disableClientGraphifyHook(settingsPath);
    expect(result.disabled).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
    expect(() => result.restore()).not.toThrow();
  });

  test('file with no graphify hook → {disabled:false}, file left unchanged', () => {
    const original = {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: '/path/to/unrelated-hook.sh' }],
          },
        ],
      },
    };
    const raw = JSON.stringify(original, null, 2) + '\n';
    writeFileSync(settingsPath, raw);

    const result = disableClientGraphifyHook(settingsPath);
    expect(result.disabled).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe(raw);
    result.restore();
    expect(readFileSync(settingsPath, 'utf8')).toBe(raw);
  });

  test('malformed JSON → {disabled:false}, no throw', () => {
    writeFileSync(settingsPath, '{ not valid json');
    const result = disableClientGraphifyHook(settingsPath);
    expect(result.disabled).toBe(false);
    expect(() => result.restore()).not.toThrow();
  });

  test('is idempotent: calling twice does not throw and second call reports disabled:false', () => {
    writeFileSync(settingsPath, JSON.stringify(settingsWithGraphifyHook(), null, 2) + '\n');
    const first = disableClientGraphifyHook(settingsPath);
    expect(first.disabled).toBe(true);
    const second = disableClientGraphifyHook(settingsPath);
    expect(second.disabled).toBe(false);
  });
});
