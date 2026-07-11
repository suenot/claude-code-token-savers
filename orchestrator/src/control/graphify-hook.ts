import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: HookMatcherGroup[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const GRAPHIFY_WORD = /(^|\s|\/)graphify(\s|$)/;

function isGraphifyCommand(cmd: HookCommand): boolean {
  if (typeof cmd.command !== 'string') return false;
  return cmd.command.includes('build-and-watch.sh') || GRAPHIFY_WORD.test(cmd.command);
}

/**
 * Idempotently disables the client-side graphify SessionStart hook in a
 * Claude Code `settings.json` while shuba manages the knowledge graph
 * itself, so the two never double-build. Preserves all other settings and
 * sibling SessionStart hook entries exactly. Returns a `restore()` that
 * puts the original file content back byte-for-byte.
 *
 * No-op (`{disabled:false}`) when the file is absent, unparsable, or has no
 * SessionStart hook whose command references `graphify` — `restore()` is
 * always safe to call in that case too.
 */
export function disableClientGraphifyHook(settingsPath: string): { disabled: boolean; restore: () => void } {
  const noop = { disabled: false, restore: () => {} };

  if (!existsSync(settingsPath)) return noop;

  const originalRaw = readFileSync(settingsPath, 'utf8');
  let data: ClaudeSettings;
  try {
    data = JSON.parse(originalRaw) as ClaudeSettings;
  } catch {
    return noop;
  }

  const sessionStart = data.hooks?.SessionStart;
  if (!Array.isArray(sessionStart)) return noop;

  let changed = false;
  const nextSessionStart: HookMatcherGroup[] = [];
  for (const group of sessionStart) {
    const groupHooks = Array.isArray(group.hooks) ? group.hooks : [];
    const kept = groupHooks.filter((h) => !isGraphifyCommand(h));
    if (kept.length !== groupHooks.length) changed = true;
    if (kept.length === 0 && groupHooks.length > 0) continue; // drop now-empty group
    nextSessionStart.push(kept.length === groupHooks.length ? group : { ...group, hooks: kept });
  }

  if (!changed) return noop;

  const next: ClaudeSettings = {
    ...data,
    hooks: { ...data.hooks, SessionStart: nextSessionStart },
  };
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');

  return {
    disabled: true,
    restore: () => {
      writeFileSync(settingsPath, originalRaw, 'utf8');
    },
  };
}
