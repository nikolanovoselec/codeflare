#!/usr/bin/env node
// Patches the installed context-mode esbuild bundles (cli.bundle.mjs +
// server.bundle.mjs) at image-build time. Implements REQ-AGENT-005 AC5 + AC8.
// See codeflare#309 for the original shim bug report.
//
// Shared by the Dockerfile build step and
// host/__tests__/dockerfile-context-mode-patch.test.js so the patch logic and
// its test cannot drift, and so the test verifies the REAL patch function
// (imported) instead of re-extracting and executing a Dockerfile heredoc.
//
// (1) createRequire shim (AC5 / issue #309): context-mode ships an esbuild
//     --format=esm bundle whose CJS-require shim throws on every dynamic
//     require('node:*') because esbuild injects no createRequire polyfill, so
//     ctx_execute / ctx_batch_execute fail with "Dynamic require of node:fs is
//     not supported" in both Node and Bun ESM. Prepend a 2-line createRequire
//     shim. Load-bearing.
// (2) update-check disable (AC8): context-mode unconditionally GETs
//     registry.npmjs.org/context-mode/latest (MCP server on boot + hourly; CLI
//     on each ctx_stats/ctx_insight render) and prints an "Update available ...
//     ctx_upgrade" notice whenever the fetched version differs. It exposes no env
//     var or flag to suppress this, and a governed container is not a surface a
//     user self-upgrades context-mode from. Repoint the probe URL to a refused
//     local address: the probe's request 'error' handler and its 5s setTimeout
//     both resolve the version to "unknown" (the fetch rejection is swallowed,
//     not thrown — verified against the pinned version; re-confirm on a pin bump),
//     so the notice never renders and no outbound npm traffic is generated.
//
// License posture (ELv2): we do NOT redistribute context-mode source. npm pulls
// the package from the public registry at build time exactly as `npx -y
// context-mode` would at runtime; this only edits the installed bundle in place.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SHIM_MARKER = '__ctx_createRequire';
export const SHIM =
  "import { createRequire as __ctx_createRequire } from 'node:module';\n" +
  'var require = __ctx_createRequire(import.meta.url);\n';
export const UPDATE_PROBE_URL = 'https://registry.npmjs.org/context-mode/latest';
export const DISABLED_PROBE_URL = 'https://127.0.0.1:1/context-mode-update-check-disabled';
export const BUNDLE_NAMES = ['cli.bundle.mjs', 'server.bundle.mjs'];

// Pure + idempotent: returns the patched source for one bundle.
export function patchContextModeBundle(content) {
  let out = content;
  // (1) createRequire shim, after a shebang if present.
  if (!out.includes(SHIM_MARKER)) {
    if (out.startsWith('#!')) {
      const nl = out.indexOf('\n');
      out = out.slice(0, nl + 1) + SHIM + out.slice(nl + 1);
    } else {
      out = SHIM + out;
    }
  }
  // (2) repoint every update-check probe occurrence; a no-op when the probe is
  // absent (e.g. upstream dropped the check), so this stays safe across versions.
  out = out.split(UPDATE_PROBE_URL).join(DISABLED_PROBE_URL);
  return out;
}

// CLI: patch the two bundles in <dir> in place. The shim is load-bearing, so its
// absence after the write is FATAL (catches a marker collision or truncated write).
function main(dir) {
  if (!dir) {
    console.error('[patch-context-mode] FATAL: missing context-mode dir (argv[2] or CTX_DIR)');
    process.exit(1);
  }
  for (const name of BUNDLE_NAMES) {
    const f = join(dir, name);
    if (!existsSync(f)) {
      console.error('[patch-context-mode] FATAL: ' + f + ' not found; context-mode layout may have changed');
      process.exit(1);
    }
    const patched = patchContextModeBundle(readFileSync(f, 'utf8'));
    writeFileSync(f, patched);
    const head = patched.startsWith('#!') ? patched.slice(patched.indexOf('\n') + 1) : patched;
    if (!head.startsWith(SHIM)) {
      console.error('[patch-context-mode] FATAL: createRequire shim missing after patch in ' + name);
      process.exit(1);
    }
    console.log('[patch-context-mode] patched ' + name + ' (createRequire shim + update-check disabled)');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2] || process.env.CTX_DIR);
}
