// Verifies the createRequire shim (AD49, codeflare#309 -- no dedicated AC) and
// REQ-AGENT-076 AC5 (context-mode npm update-check notice disabled at image
// build) by exercising the
// REAL patch function the Dockerfile build runs — imported from
// scripts/patch-context-mode-bundles.mjs, the same module the Dockerfile invokes.
// Importing the shared function (rather than re-extracting and executing a
// Dockerfile heredoc) means the patch logic and its test cannot drift, and the
// assertions are exact-equality contracts: gut the shim or the probe disable and
// the expected output no longer matches.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  patchContextModeBundle,
  patchContextModeInstallations,
  SHIM,
  UPDATE_PROBE_URL,
  DISABLED_PROBE_URL,
  BUNDLE_NAMES,
} from '../../scripts/patch-context-mode-bundles.mjs';

// A bundle body referencing the probe URL `n` times (the real cli bundle has it
// twice — the boot + render probes; the server bundle once). JSON.stringify embeds
// the URL as a quoted literal exactly as esbuild would.
const bodyWithProbe = (url, n) =>
  Array.from({ length: n }, (_, i) => `function probe${i}(){return get(${JSON.stringify(url)})}`).join('\n') + '\n';

describe('Context-mode installation patch (createRequire shim + REQ-AGENT-076 AC5 update-check disable)', () => {
  it('AC5: neutralizes the npm update-check probe in both bundles', () => {
    // Every probe occurrence repointed to the refused local address, and the shim
    // prepended — asserted by exact equality, so a partial or skipped replace fails.
    const raw = 'var a=1;\n' + bodyWithProbe(UPDATE_PROBE_URL, 2);
    const expected = SHIM + 'var a=1;\n' + bodyWithProbe(DISABLED_PROBE_URL, 2);
    assert.equal(patchContextModeBundle(raw), expected);
    // And the server-shaped single-occurrence bundle.
    const rawServer = 'var b=2;\n' + bodyWithProbe(UPDATE_PROBE_URL, 1);
    const expectedServer = SHIM + 'var b=2;\n' + bodyWithProbe(DISABLED_PROBE_URL, 1);
    assert.equal(patchContextModeBundle(rawServer), expectedServer);
    // AC5 safety contract: the disabled target must be a loopback host so the probe
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

  it('patches both installed copies and rejects version drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeflare-context-mode-'));
    try {
      const shared = join(root, 'shared');
      const prewarm = join(root, 'prewarm');
      for (const directory of [shared, prewarm]) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'package.json'), '{"version":"1.2.3"}\n');
        for (const bundle of BUNDLE_NAMES) {
          writeFileSync(join(directory, bundle), `var bundle = "${UPDATE_PROBE_URL}";\n`);
        }
      }

      patchContextModeInstallations('1.2.3', shared, prewarm);
      for (const directory of [shared, prewarm]) {
        for (const bundle of BUNDLE_NAMES) {
          assert.equal(
            readFileSync(join(directory, bundle), 'utf8'),
            `${SHIM}var bundle = "${DISABLED_PROBE_URL}";\n`,
          );
        }
      }

      writeFileSync(join(shared, 'package.json'), '{"version":"1.2.2"}\n');
      assert.throws(
        () => patchContextModeInstallations('1.2.3', shared, prewarm),
        /locked context-mode 1\.2\.2 != plugin\.json 1\.2\.3/,
      );
      writeFileSync(join(shared, 'package.json'), '{"version":"1.2.3"}\n');
      writeFileSync(join(prewarm, 'package.json'), '{"version":"1.2.2"}\n');
      assert.throws(
        () => patchContextModeInstallations('1.2.3', shared, prewarm),
        /Pi context-mode 1\.2\.2 != plugin\.json 1\.2\.3/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
