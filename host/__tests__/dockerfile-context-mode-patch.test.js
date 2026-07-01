// Verifies the createRequire shim (AD49, codeflare#309 -- no dedicated AC) and
// REQ-AGENT-076 AC4 (context-mode npm update-check notice disabled at image
// build) by exercising the
// REAL patch function the Dockerfile build runs — imported from
// scripts/patch-context-mode-bundles.mjs, the same module the Dockerfile invokes.
// Importing the shared function (rather than re-extracting and executing a
// Dockerfile heredoc) means the patch logic and its test cannot drift, and the
// assertions are exact-equality contracts: gut the shim or the probe disable and
// the expected output no longer matches.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  patchContextModeBundle,
  SHIM,
  UPDATE_PROBE_URL,
  DISABLED_PROBE_URL,
} from '../../scripts/patch-context-mode-bundles.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
const piPkg = JSON.parse(readFileSync(join(repoRoot, 'preseed/agents/pi/package.json'), 'utf8'));
const ctxPluginVer = JSON.parse(
  readFileSync(join(repoRoot, 'preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json'), 'utf8')
).version;

// A bundle body referencing the probe URL `n` times (the real cli bundle has it
// twice — the boot + render probes; the server bundle once). JSON.stringify embeds
// the URL as a quoted literal exactly as esbuild would.
const bodyWithProbe = (url, n) =>
  Array.from({ length: n }, (_, i) => `function probe${i}(){return get(${JSON.stringify(url)})}`).join('\n') + '\n';

describe('Dockerfile context-mode patch (createRequire shim + REQ-AGENT-076 AC4 update-check disable)', () => {
  it('AC4: neutralizes the npm update-check probe in both bundles', () => {
    // Every probe occurrence repointed to the refused local address, and the shim
    // prepended — asserted by exact equality, so a partial or skipped replace fails.
    const raw = 'var a=1;\n' + bodyWithProbe(UPDATE_PROBE_URL, 2);
    const expected = SHIM + 'var a=1;\n' + bodyWithProbe(DISABLED_PROBE_URL, 2);
    assert.equal(patchContextModeBundle(raw), expected);
    // And the server-shaped single-occurrence bundle.
    const rawServer = 'var b=2;\n' + bodyWithProbe(UPDATE_PROBE_URL, 1);
    const expectedServer = SHIM + 'var b=2;\n' + bodyWithProbe(DISABLED_PROBE_URL, 1);
    assert.equal(patchContextModeBundle(rawServer), expectedServer);
    // AC4 safety contract: the disabled target must be a loopback host so the probe
    // generates no outbound traffic. Parse + check the host (not a substring match)
    // so a future edit to a routable URL fails here.
    assert.equal(new URL(DISABLED_PROBE_URL).hostname, '127.0.0.1');
  });

  it('prepends the createRequire shim, preserving a shebang line', () => {
    assert.equal(patchContextModeBundle('var a=1;\n'), SHIM + 'var a=1;\n');
    const shebang = '#!/usr/bin/env node\nvar a=1;\n';
    assert.equal(patchContextModeBundle(shebang), '#!/usr/bin/env node\n' + SHIM + 'var a=1;\n');
    // Degenerate shebang with no trailing newline: shim still lands after it.
    assert.equal(patchContextModeBundle('#!/usr/bin/env node'), '#!/usr/bin/env node\n' + SHIM);
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

// The patch FUNCTION working is necessary but not sufficient — the bug that shipped was the
// Dockerfile only running it on the GLOBAL install while Pi loads its OWN copy (npm:context-mode
// resolved from ~/.pi/agent/npm/node_modules, a symlink to the build prewarm tree). These assert
// the Dockerfile patches BOTH installs and guards the two version pins from drifting.
describe('Dockerfile patches context-mode in BOTH installs (global + Pi prewarm)', () => {
  it('patches the global install (Claude MCP bin)', () => {
    assert.match(dockerfile, /node \/tmp\/patch-context-mode-bundles\.mjs "\$CTX_DIR"/);
  });

  it('patches the Pi prewarm copy (what Pi loads via npm:context-mode)', () => {
    assert.match(dockerfile, /PI_CTX_DIR="\/opt\/codeflare\/pi-agent\/npm\/node_modules\/context-mode"/);
    assert.match(dockerfile, /node \/tmp\/patch-context-mode-bundles\.mjs "\$PI_CTX_DIR"/);
  });

  it('asserts the two version pins match so they cannot silently drift', () => {
    // The build FATALs if Pi's pinned context-mode != plugin.json's version.
    assert.match(dockerfile, /Pi context-mode .* != plugin\.json/);
    // And the committed pins are in fact equal right now.
    assert.equal(piPkg.dependencies['context-mode'], ctxPluginVer);
  });
});
