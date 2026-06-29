// Verifies REQ-AGENT-005 AC5 (createRequire shim, codeflare#309) and AC8
// (context-mode npm update-check notice disabled at image build) by exercising the
// REAL patch function the Dockerfile build runs — imported from
// scripts/patch-context-mode-bundles.mjs, the same module the Dockerfile invokes.
// Importing the shared function (rather than re-extracting and executing a
// Dockerfile heredoc) means the patch logic and its test cannot drift, and the
// assertions are exact-equality contracts: gut the shim or the probe disable and
// the expected output no longer matches.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  patchContextModeBundle,
  SHIM,
  UPDATE_PROBE_URL,
  DISABLED_PROBE_URL,
} from '../../scripts/patch-context-mode-bundles.mjs';

// A bundle body referencing the probe URL `n` times (the real cli bundle has it
// twice — the boot + render probes; the server bundle once). JSON.stringify embeds
// the URL as a quoted literal exactly as esbuild would.
const bodyWithProbe = (url, n) =>
  Array.from({ length: n }, (_, i) => `function probe${i}(){return get(${JSON.stringify(url)})}`).join('\n') + '\n';

describe('Dockerfile context-mode patch (REQ-AGENT-005 AC5 shim + AC8 update-check disable)', () => {
  it('AC8: neutralizes the npm update-check probe in both bundles', () => {
    // Every probe occurrence repointed to the refused local address, and the shim
    // prepended — asserted by exact equality, so a partial or skipped replace fails.
    const raw = 'var a=1;\n' + bodyWithProbe(UPDATE_PROBE_URL, 2);
    const expected = SHIM + 'var a=1;\n' + bodyWithProbe(DISABLED_PROBE_URL, 2);
    assert.equal(patchContextModeBundle(raw), expected);
    // And the server-shaped single-occurrence bundle.
    const rawServer = 'var b=2;\n' + bodyWithProbe(UPDATE_PROBE_URL, 1);
    const expectedServer = SHIM + 'var b=2;\n' + bodyWithProbe(DISABLED_PROBE_URL, 1);
    assert.equal(patchContextModeBundle(rawServer), expectedServer);
  });

  it('AC5: prepends the createRequire shim, preserving a shebang line', () => {
    assert.equal(patchContextModeBundle('var a=1;\n'), SHIM + 'var a=1;\n');
    const shebang = '#!/usr/bin/env node\nvar a=1;\n';
    assert.equal(patchContextModeBundle(shebang), '#!/usr/bin/env node\n' + SHIM + 'var a=1;\n');
  });

  it('is idempotent: a second pass adds no duplicate shim and keeps the probe disabled', () => {
    const once = patchContextModeBundle('var a=1;\n' + bodyWithProbe(UPDATE_PROBE_URL, 2));
    assert.equal(patchContextModeBundle(once), once);
  });

  it('warn-only when upstream removed the probe: shim still applied, nothing to repoint', () => {
    const raw = 'var a=1;\n';
    assert.equal(patchContextModeBundle(raw), SHIM + raw);
  });
});
