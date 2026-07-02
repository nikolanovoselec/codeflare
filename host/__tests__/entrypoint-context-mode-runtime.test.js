import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

describe('context-mode bridge idle-reaper not globally disabled by the entrypoint (REQ-AGENT-076 AC6)', () => {
  it('entrypoint never sets or exports a global CONTEXT_MODE_BRIDGE_IDLE_MS override', () => {
    // A global override would also disable the reaper for non-foreground/subagent bridge children,
    // so they never self-release and pile up (server.bundle.mjs helpers). Regression guard: a real
    // `CONTEXT_MODE_BRIDGE_IDLE_MS=<value>` assignment (with or without `export`) must never come
    // back on a non-comment line (a comment mentioning the var does not match — `#` lines skipped).
    const forcesOverride = /^[^\n#]*\bCONTEXT_MODE_BRIDGE_IDLE_MS\s*=/m.test(entrypoint);
    assert.equal(forcesOverride, false,
      'entrypoint.sh must not set/export a global CONTEXT_MODE_BRIDGE_IDLE_MS override');
  });
});
