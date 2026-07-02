import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

describe('entrypoint does not globally disable the context-mode bridge idle-reaper', () => {
  it('never force-exports CONTEXT_MODE_BRIDGE_IDLE_MS (context-mode #868 governs foreground vs subagent)', () => {
    // A global export would also disable the reaper for non-foreground/subagent bridge children,
    // so they never self-release and pile up (server.bundle.mjs helpers). Regression guard: a
    // real `export CONTEXT_MODE_BRIDGE_IDLE_MS=<value>` line must never come back (a comment
    // mentioning the var does not match — the pattern requires an actual export statement).
    const forcesOverride = /^[^\n#]*\bexport\s+CONTEXT_MODE_BRIDGE_IDLE_MS\s*=/m.test(entrypoint);
    assert.equal(forcesOverride, false,
      'entrypoint.sh must not export a global CONTEXT_MODE_BRIDGE_IDLE_MS override');
  });
});
