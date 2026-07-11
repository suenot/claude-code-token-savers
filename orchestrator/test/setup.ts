import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Point stage toggles at a per-run scratch file so the developer's real
// ~/.shuba/runtime.json (which may have stages toggled off) never leaks into
// tests. Tests that exercise toggles still set/restore SHUBA_RUNTIME themselves.
process.env.SHUBA_RUNTIME ??= join(tmpdir(), `shuba-test-runtime-${process.pid}.json`);
