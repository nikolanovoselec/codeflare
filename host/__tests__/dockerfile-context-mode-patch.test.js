// Verifies REQ-AGENT-005 AC8 (context-mode "Update available" notice disabled
// at image-build time) and the pre-existing createRequire shim (REQ-AGENT-005
// AC5 / issue #309) by EXTRACTING the Node patch heredoc embedded in the
// Dockerfile and EXECUTING it against fixture bundles. Building the real image
// is forbidden locally (resource-constrained), so running the actual patch
// logic against fixtures is the honest behavioral check: gut the disable and
// the fixture keeps the live npm probe URL -> the test fails.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8');

const PROBE_URL = 'https://registry.npmjs.org/context-mode/latest';
const DISABLED_URL = 'https://127.0.0.1:1/context-mode-update-check-disabled';
const SHIM_HEAD = "import { createRequire as __ctx_createRequire } from 'node:module';";

// Pull the `node <<'NODE' ... NODE` script body out of the context-mode RUN block.
function extractPatchScript() {
  const m = dockerfile.match(/\nnode <<'NODE'\n([\s\S]*?)\nNODE\n/);
  assert.ok(m, "Dockerfile must embed the context-mode patch as a `node <<'NODE' ... NODE` heredoc");
  return m[1];
}

// Run the extracted patch with CTX_DIR pointed at a fixture dir; return result.
function runPatch(ctxDir) {
  const scriptPath = join(ctxDir, '__patch.cjs');
  writeFileSync(scriptPath, extractPatchScript());
  return spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, CTX_DIR: ctxDir },
    encoding: 'utf8',
  });
}

function seedFixtures(ctxDir, { cli, server }) {
  writeFileSync(join(ctxDir, 'cli.bundle.mjs'), cli);
  writeFileSync(join(ctxDir, 'server.bundle.mjs'), server);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('Dockerfile context-mode patch (REQ-AGENT-005 AC5 shim + AC8 update-check disable)', () => {
  it('AC8: neutralizes the npm update-check probe in both bundles (every occurrence)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxpatch-'));
    try {
      seedFixtures(dir, {
        // cli carries the probe twice (the boot + render paths), as the real bundle does
        cli: `var a=1;function PR(){return get(${JSON.stringify(PROBE_URL)})}\nfunction U4(){return get(${JSON.stringify(PROBE_URL)})}\n`,
        server: `var b=2;function fT(){return get(${JSON.stringify(PROBE_URL)})}\n`,
      });
      const r = runPatch(dir);
      assert.equal(r.status, 0, `patch must exit 0; stderr: ${r.stderr}`);

      for (const name of ['cli.bundle.mjs', 'server.bundle.mjs']) {
        const out = readFileSync(join(dir, name), 'utf8');
        assert.ok(!out.includes(PROBE_URL), `${name} must not retain the live npm probe URL`);
        assert.ok(out.includes(DISABLED_URL), `${name} must repoint the probe to the refused local address`);
      }
      // cli had two probe occurrences -> both replaced
      assert.equal(
        countOccurrences(readFileSync(join(dir, 'cli.bundle.mjs'), 'utf8'), DISABLED_URL),
        2,
        'every probe occurrence in cli.bundle.mjs must be replaced'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC5: prepends the createRequire shim to both bundles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxpatch-'));
    try {
      seedFixtures(dir, {
        cli: `var a=1;${JSON.stringify(PROBE_URL)}\n`,
        server: `var b=2;${JSON.stringify(PROBE_URL)}\n`,
      });
      const r = runPatch(dir);
      assert.equal(r.status, 0, `patch must exit 0; stderr: ${r.stderr}`);
      for (const name of ['cli.bundle.mjs', 'server.bundle.mjs']) {
        const out = readFileSync(join(dir, name), 'utf8');
        assert.ok(out.startsWith(SHIM_HEAD), `${name} must start with the createRequire shim`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second run adds no duplicate shim and keeps the probe disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxpatch-'));
    try {
      seedFixtures(dir, {
        cli: `var a=1;${JSON.stringify(PROBE_URL)}\n`,
        server: `var b=2;${JSON.stringify(PROBE_URL)}\n`,
      });
      assert.equal(runPatch(dir).status, 0);
      const second = runPatch(dir);
      assert.equal(second.status, 0, `second run must exit 0; stderr: ${second.stderr}`);
      for (const name of ['cli.bundle.mjs', 'server.bundle.mjs']) {
        const out = readFileSync(join(dir, name), 'utf8');
        assert.equal(
          countOccurrences(out, '__ctx_createRequire(import.meta.url)'),
          1,
          `${name} must carry exactly one shim after two runs`
        );
        assert.ok(!out.includes(PROBE_URL), `${name} must still have the probe disabled`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fail the build when upstream removed the probe (warn-only, postcondition holds)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxpatch-'));
    try {
      // No probe URL present at all (a future context-mode could drop the check)
      seedFixtures(dir, { cli: 'var a=1;\n', server: 'var b=2;\n' });
      const r = runPatch(dir);
      assert.equal(r.status, 0, `patch must not FATAL when the probe is absent; stderr: ${r.stderr}`);
      for (const name of ['cli.bundle.mjs', 'server.bundle.mjs']) {
        const out = readFileSync(join(dir, name), 'utf8');
        assert.ok(out.startsWith(SHIM_HEAD), `${name} must still receive the shim`);
        assert.ok(!out.includes(PROBE_URL), `${name} must not contain the live probe URL`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
