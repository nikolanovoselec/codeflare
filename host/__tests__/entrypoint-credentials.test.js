// Real behavioral tests for the deploy-credential wiring in entrypoint.sh.
//
// REQ-AGENT-029 AC3: when a GitHub credential is present, the container
// configures git for authenticated HTTPS access via a credential helper.
// The previous coverage was the spec's own `coverage-gap` admission plus
// source-string audits; this test RUNS the real entrypoint snippet with a
// stubbed `git` (logging its argv) and asserts the helper is configured
// only when GH_TOKEN is set — assertion is on the stub's recorded call,
// not on the source text.
//
// REQ-AGENT-029 AC4: see the "AC4 is not entrypoint.sh shell logic" note
// at the bottom — it is intentionally NOT given a fake test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

// Extract the GH_TOKEN credential-helper block (the
// `if [ -n "${GH_TOKEN:-}" ]; then ... fi` near the end of MAIN
// EXECUTION). Anchored on its unique comment so the slice tracks the real
// snippet. We execute the slice and assert on side effects, never on its
// text.
function extractCredentialHelperBlock() {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const anchor = lines.findIndex((l) =>
    /^# Configure git credential helper for pre-configured deploy tokens/.test(l),
  );
  if (anchor === -1) {
    throw new Error('Could not locate the git credential-helper anchor comment in entrypoint.sh');
  }
  let ifIdx = -1;
  for (let i = anchor; i < lines.length; i++) {
    if (/^if \[ -n "\$\{GH_TOKEN:-\}" \]; then/.test(lines[i])) {
      ifIdx = i;
      break;
    }
  }
  if (ifIdx === -1) throw new Error('Could not locate the GH_TOKEN guard');
  let fiIdx = -1;
  for (let i = ifIdx + 1; i < lines.length; i++) {
    if (/^fi$/.test(lines[i])) {
      fiIdx = i;
      break;
    }
  }
  if (fiIdx === -1) throw new Error('Could not locate the closing fi of the GH_TOKEN block');
  return lines.slice(ifIdx, fiIdx + 1).join('\n');
}

// Render a harness that stubs `git` to record its argv to a log, sets (or
// leaves unset) GH_TOKEN, runs the extracted snippet, then prints what (if
// anything) `git config --global credential.helper` was asked to set. The
// stub remembers the last credential.helper value so the test can confirm
// the helper actually routes through the token, not just that git was
// invoked.
function buildHarness({ block, gitLog, ghToken /* string | undefined */ }) {
  const tokenLine =
    ghToken === undefined ? 'unset GH_TOKEN' : `export GH_TOKEN=${JSON.stringify(ghToken)}`;
  return `
    set +e
    # Stub git: log full argv; when configuring credential.helper, persist
    # the value so the test can read back the exact helper string.
    git() {
      echo "GIT_ARGS: $*" >> "${gitLog}"
      if [ "$1" = "config" ] && [ "$2" = "--global" ] && [ "$3" = "credential.helper" ]; then
        echo "CREDENTIAL_HELPER_SET: $4" >> "${gitLog}"
      fi
      return 0
    }
    ${tokenLine}

    ${block}
  `;
}

function runBash(script) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

describe('entrypoint.sh deploy-credential wiring (real) / REQ-AGENT-029 (deploy credential propagation)', () => {
  // -------------------------------------------------------------------------
  // REQ-AGENT-029 AC3 — credential.helper configured iff GH_TOKEN present.
  // -------------------------------------------------------------------------
  it('configures git credential.helper when GH_TOKEN is set (REQ-AGENT-029 AC3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-set-'));
    const gitLog = join(dir, 'git.log');
    const block = extractCredentialHelperBlock();

    const res = runBash(buildHarness({ block, gitLog, ghToken: 'ghp_fake_token_value' }));
    assert.equal(res.status, 0, `snippet must run cleanly; stderr: ${res.stderr}`);
    assert.ok(existsSync(gitLog), 'git stub should have been invoked when GH_TOKEN is set');
    const log = readFileSync(gitLog, 'utf8');

    assert.match(
      log,
      /CREDENTIAL_HELPER_SET:/,
      'git config --global credential.helper must be called when GH_TOKEN is present',
    );
    // The helper must route auth through the token: it echoes the
    // x-access-token username and the $GH_TOKEN password. Assert the
    // contract shape of the helper value, not entrypoint source text.
    assert.match(
      log,
      /CREDENTIAL_HELPER_SET:.*username=x-access-token/,
      'credential helper must emit the x-access-token username',
    );
    assert.match(
      log,
      /CREDENTIAL_HELPER_SET:.*password=\$GH_TOKEN/,
      'credential helper must emit the GH_TOKEN-backed password so HTTPS auth uses the deploy token',
    );
  });

  it('does NOT configure git credential.helper when GH_TOKEN is unset (REQ-AGENT-029 AC3: guard)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-unset-'));
    const gitLog = join(dir, 'git.log');
    const block = extractCredentialHelperBlock();

    const res = runBash(buildHarness({ block, gitLog, ghToken: undefined }));
    assert.equal(res.status, 0, `snippet must run cleanly; stderr: ${res.stderr}`);

    // The git stub must NOT have been invoked at all: the whole block is
    // guarded by `[ -n "${GH_TOKEN:-}" ]`. No log file (or an empty one)
    // proves the guard held. If the guard were removed, the stub would
    // record a CREDENTIAL_HELPER_SET line and this fails.
    const log = existsSync(gitLog) ? readFileSync(gitLog, 'utf8') : '';
    assert.doesNotMatch(
      log,
      /CREDENTIAL_HELPER_SET:/,
      'credential.helper must NOT be configured when GH_TOKEN is absent',
    );
    assert.doesNotMatch(log, /GIT_ARGS:/, 'git must not be invoked at all when GH_TOKEN is absent');
  });

  // -------------------------------------------------------------------------
  // REQ-AGENT-029 AC4 — CLOUDFLARE_ACCOUNT_ID auto-resolution from the API
  // token.
  //
  // legit-non-testable AS ENTRYPOINT.SH SHELL LOGIC: this AC's behavior is
  // NOT implemented in entrypoint.sh. An exhaustive scan of entrypoint.sh
  // finds the only references to CLOUDFLARE_ACCOUNT_ID are *consumers* of an
  // already-injected value (the browser-run CDP endpoint + browser-run MCP
  // config, both behind `[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]`); there is no
  // curl / API call that derives the account id from the API token in the
  // shell (the only `curl` in entrypoint.sh is the localhost :8080 health
  // probe). The actual from-token resolution lives in the TypeScript Setup /
  // auto-fetch step under src/ (e.g. src/lib/browser-render-token.ts /
  // src/container/container-env.ts) and is already covered by a real test
  // that mocks the Cloudflare /accounts endpoint
  // (src/__tests__/setup-ac-coverage.test.ts). Writing a bash-subshell test
  // here would have nothing real to execute — it would be theater. The
  // honest fix is at the spec layer (correct AC4's `@impl: entrypoint.sh`
  // pointer to the src/ resolver), which this task explicitly forbids
  // touching (do NOT edit sdd/). So AC4 is deliberately left without a
  // (fake) entrypoint test; its genuine coverage is the src/ test above.
  // -------------------------------------------------------------------------
});
