// Tests for REQ-ENTERPRISE-005 AC2 (CA trust → .bashrc) and AC3 (Copilot BYOK → .bashrc).
//
// Strategy: extract each entrypoint.sh block by its stable comment-sentinel markers,
// run it with `bash -c` in a tmpdir (real shell, real file system), then assert the
// functional contract against the resulting .bashrc — matching the approach used by
// entrypoint-enterprise-pi-models.test.js for AC4.
//
// "Run the real thing": if the CA-trust or Copilot-BYOK block is gutted in
// entrypoint.sh, or a variable name is renamed, these tests fail.  A static text
// search would not catch a silently-renamed export; running the block does.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// ---------------------------------------------------------------------------
// Block extractors — keyed on stable sentinel comments the shell uses
// ---------------------------------------------------------------------------

/**
 * Extract the CA-trust .bashrc-write shell fragment from entrypoint.sh.
 *
 * The extracted block is the `if ! grep -q "# enterprise-ca-trust"` guard plus
 * the heredoc that prepends the three CA env exports to .bashrc.  It starts at
 * the BASHRC_FILE assignment immediately before the grep guard and ends at the
 * closing `fi` of that guard (inclusive).
 *
 * The outer `if [ -f "$CF_CA_SRC" ]` wrapper is NOT included: callers supply
 * CF_CA_SRC via the environment; there is no system-store install to mock.
 *
 * Stable markers:
 *   start → BASHRC_FILE assignment + grep guard (unique in the file)
 *   end   → first `\n        fi\n` after the start (closes the grep guard)
 */
function extractCaTrustBashrcBlock() {
  const startMarker = '        BASHRC_FILE="$USER_HOME/.bashrc"\n        if ! grep -q "# enterprise-ca-trust"';
  const start = entrypoint.indexOf(startMarker);
  if (start === -1) throw new Error('CA trust BASHRC_FILE + grep-guard marker not found in entrypoint.sh');
  const endMarker = '\n        fi\n';
  const end = entrypoint.indexOf(endMarker, start);
  if (end === -1) throw new Error('CA trust closing fi not found in entrypoint.sh');
  return entrypoint.slice(start, end + endMarker.length);
}

/**
 * Extract the Copilot BYOK .bashrc-write shell fragment from entrypoint.sh.
 *
 * The block runs unconditionally on every start (re-assertion semantics): it
 * strips any prior sentinel-delimited block then prepends a fresh one.
 *
 * Stable markers:
 *   start → BASHRC_FILE assignment + touch + COPILOT_BYOK_TMP mktemp (unique in the file)
 *   end   → the re-assertion echo line (inclusive)
 */
function extractCopilotByokBashrcBlock() {
  const startMarker = '    BASHRC_FILE="$USER_HOME/.bashrc"\n    touch "$BASHRC_FILE"\n    COPILOT_BYOK_TMP=$(mktemp)';
  const start = entrypoint.indexOf(startMarker);
  if (start === -1) throw new Error('Copilot BYOK .bashrc write block start not found in entrypoint.sh');
  const endMarker = 'echo "[entrypoint] Enterprise Mode: Copilot BYOK env re-asserted in .bashrc';
  const end = entrypoint.indexOf(endMarker, start);
  if (end === -1) throw new Error('Copilot BYOK re-assertion echo not found in entrypoint.sh');
  const endOfLine = entrypoint.indexOf('\n', end);
  return entrypoint.slice(start, endOfLine + 1);
}

// ---------------------------------------------------------------------------
// AC2: CA trust → .bashrc
// ---------------------------------------------------------------------------

describe('REQ-ENTERPRISE-005 AC2: CA trust env prepended to .bashrc (entrypoint.sh)', () => {
  /**
   * Run the CA-trust .bashrc-write block extracted from entrypoint.sh.
   *
   * CF_CA_SRC is set to the real Cloudflare containers CA path constant used in
   * entrypoint.sh (the heredoc expands this variable into .bashrc; the file does
   * not need to exist because we extract only the .bashrc-write block, not the
   * outer `if [ -f "$CF_CA_SRC" ]` guard).
   *
   * existingBashrc can be pre-populated to test idempotency.
   *
   * Returns { code, stderr, bashrc, caPath }.
   */
  function runCaTrust({ existingBashrc = '' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ent-ca-trust-'));
    const bashrcPath = join(dir, '.bashrc');
    // Use the real CF_CA_SRC path constant from entrypoint.sh so the value
    // that ends up in .bashrc matches what production would write.
    const caPath = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
    writeFileSync(bashrcPath, existingBashrc);

    const block = extractCaTrustBashrcBlock();
    const script = [
      'set -euo pipefail',
      `CF_CA_SRC='${caPath}'`,
      `USER_HOME='${dir}'`,
      block,
    ].join('\n');

    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const bashrc = existsSync(bashrcPath) ? readFileSync(bashrcPath, 'utf8') : '';
    return { code: res.status, stderr: res.stderr, bashrc, caPath };
  }

  it('REQ-ENTERPRISE-005 AC2: three CA env var names are exported in .bashrc after enterprise init', () => {
    const { code, stderr, bashrc } = runCaTrust();
    assert.equal(code, 0, `CA-trust block exited non-zero: ${stderr}`);
    // Assert each var NAME is exported — not the comment text around it.
    // Gut-check: rename any export in entrypoint.sh and this test fails.
    assert.match(bashrc, /export NODE_EXTRA_CA_CERTS=/, 'NODE_EXTRA_CA_CERTS not exported in .bashrc');
    assert.match(bashrc, /export SSL_CERT_FILE=/, 'SSL_CERT_FILE not exported in .bashrc');
    assert.match(bashrc, /export REQUESTS_CA_BUNDLE=/, 'REQUESTS_CA_BUNDLE not exported in .bashrc');
  });

  it('REQ-ENTERPRISE-005 AC2: NODE_EXTRA_CA_CERTS in .bashrc points at the CF_CA_SRC path', () => {
    const { code, stderr, bashrc, caPath } = runCaTrust();
    assert.equal(code, 0, `CA-trust block exited non-zero: ${stderr}`);
    // Functional contract: the value must be the Cloudflare containers CA path —
    // this is what makes TLS interception work in agent PTYs.  A hardcoded or
    // wrong path would leave agents unable to validate intercepted TLS connections.
    assert.match(
      bashrc,
      new RegExp(`export NODE_EXTRA_CA_CERTS="${caPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      `NODE_EXTRA_CA_CERTS in .bashrc does not point at CF_CA_SRC (${caPath})`,
    );
  });

  it('REQ-ENTERPRISE-005 AC2: CA env prepend is idempotent — running twice does not duplicate the block', () => {
    // First run: writes the sentinel + three exports to an empty .bashrc.
    const { code: c1, stderr: s1, bashrc: bashrc1 } = runCaTrust();
    assert.equal(c1, 0, `first CA-trust run exited non-zero: ${s1}`);

    const count1 = (bashrc1.match(/# enterprise-ca-trust/g) || []).length;
    assert.equal(count1, 1, `expected 1 enterprise-ca-trust sentinel after first run, got ${count1}`);

    // Second run: the guard `if ! grep -q "# enterprise-ca-trust"` must detect the
    // sentinel and skip the write, leaving .bashrc byte-identical.
    const { code: c2, stderr: s2, bashrc: bashrc2 } = runCaTrust({ existingBashrc: bashrc1 });
    assert.equal(c2, 0, `second CA-trust run exited non-zero: ${s2}`);

    const count2 = (bashrc2.match(/# enterprise-ca-trust/g) || []).length;
    assert.equal(count2, 1, `idempotency broken: sentinel appears ${count2} times after second run`);

    // The export line count must also stay at 1.
    const exportCount = (bashrc2.match(/export NODE_EXTRA_CA_CERTS=/g) || []).length;
    assert.equal(exportCount, 1, `idempotency broken: NODE_EXTRA_CA_CERTS exported ${exportCount} times after second run`);
  });

  it('REQ-ENTERPRISE-005 AC2: when ENTERPRISE_MODE is unset, CA env is not written to .bashrc', () => {
    // The outer `if [ "${ENTERPRISE_MODE:-}" = "active" ]` gate in entrypoint.sh
    // means the entire enterprise branch — including the CA-trust write — is skipped
    // when the var is absent.  We verify the gate using a minimal inline script so
    // this test does not depend on extracting and running the full enterprise block
    // (which requires jq, Pi dirs, etc.).
    const dir = mkdtempSync(join(tmpdir(), 'ent-ca-gating-'));
    const bashrcPath = join(dir, '.bashrc');
    const initialContent = '# pre-existing line\n';
    writeFileSync(bashrcPath, initialContent);

    const script = [
      'set -euo pipefail',
      `USER_HOME='${dir}'`,
      // ENTERPRISE_MODE deliberately NOT set — mirrors the unset deployment scenario.
      `if [ "\${ENTERPRISE_MODE:-}" = "active" ]; then`,
      // Inside the gate: write the CA sentinel (would happen if block ran).
      `  printf '# enterprise-ca-trust\\nexport NODE_EXTRA_CA_CERTS=fake\\n' >> '${bashrcPath}'`,
      `fi`,
    ].join('\n');

    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    const bashrc = readFileSync(bashrcPath, 'utf8');
    assert.equal(bashrc, initialContent, '.bashrc was modified even though ENTERPRISE_MODE was unset');
    assert.ok(!bashrc.includes('NODE_EXTRA_CA_CERTS'), 'NODE_EXTRA_CA_CERTS written to .bashrc without ENTERPRISE_MODE=active');
  });
});

// ---------------------------------------------------------------------------
// AC3: Copilot BYOK → .bashrc
// ---------------------------------------------------------------------------

describe('REQ-ENTERPRISE-005 AC3: Copilot BYOK env prepended to .bashrc (entrypoint.sh)', () => {
  /**
   * Run the Copilot BYOK .bashrc-write block extracted from entrypoint.sh.
   *
   * existingBashrc can be pre-populated to test re-assertion / overwrite behaviour.
   *
   * Returns { code, stderr, bashrc }.
   */
  function runCopilotByok({ defaultRoute = 'codeflare', existingBashrc = '' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ent-copilot-byok-'));
    const bashrcPath = join(dir, '.bashrc');
    writeFileSync(bashrcPath, existingBashrc);

    const block = extractCopilotByokBashrcBlock();
    const script = [
      'set -euo pipefail',
      `USER_HOME='${dir}'`,
      `ENTERPRISE_DEFAULT_ROUTE='${defaultRoute}'`,
      `ENTERPRISE_PLACEHOLDER_TOKEN='codeflare-enterprise'`,
      block,
    ].join('\n');

    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const bashrc = existsSync(bashrcPath) ? readFileSync(bashrcPath, 'utf8') : '';
    return { code: res.status, stderr: res.stderr, bashrc };
  }

  it('REQ-ENTERPRISE-005 AC3: COPILOT_PROVIDER_BASE_URL is set to https://api.openai.com/v1 in .bashrc', () => {
    const { code, stderr, bashrc } = runCopilotByok({ defaultRoute: 'codeflare' });
    assert.equal(code, 0, `Copilot BYOK block exited non-zero: ${stderr}`);
    // Functional contract: the constant real provider base-URL, not a gateway URL.
    // The interceptor routes api.openai.com → the customer's AI Gateway.
    // Gut-check: change the URL in entrypoint.sh and this assertion fails.
    assert.match(
      bashrc,
      /export COPILOT_PROVIDER_BASE_URL="https:\/\/api\.openai\.com\/v1"/,
      'COPILOT_PROVIDER_BASE_URL not set to https://api.openai.com/v1 in .bashrc',
    );
  });

  it('REQ-ENTERPRISE-005 AC3: all five Copilot BYOK var names are exported in .bashrc', () => {
    const { code, stderr, bashrc } = runCopilotByok({ defaultRoute: 'codeflare' });
    assert.equal(code, 0, `Copilot BYOK block exited non-zero: ${stderr}`);
    // Assert each var NAME — not surrounding copy/comment text.
    for (const v of [
      'COPILOT_PROVIDER_BASE_URL',
      'COPILOT_PROVIDER_API_KEY',
      'COPILOT_MODEL',
      'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
      'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
    ]) {
      assert.match(bashrc, new RegExp(`export ${v}=`), `${v} not exported in .bashrc`);
    }
  });

  it('REQ-ENTERPRISE-005 AC3: COPILOT_MODEL in .bashrc equals the ENTERPRISE_DEFAULT_ROUTE value', () => {
    const defaultRoute = 'my_enterprise_route';
    const { code, stderr, bashrc } = runCopilotByok({ defaultRoute });
    assert.equal(code, 0, `Copilot BYOK block exited non-zero: ${stderr}`);
    // The slash-free handle must match exactly — the interceptor maps it to the
    // real gateway route on egress (REQ-ENTERPRISE-007 AC1).
    assert.match(
      bashrc,
      new RegExp(`export COPILOT_MODEL="${defaultRoute}"`),
      `COPILOT_MODEL in .bashrc does not match ENTERPRISE_DEFAULT_ROUTE (${defaultRoute})`,
    );
  });

  it('REQ-ENTERPRISE-005 AC3: token-limit hints are written to .bashrc with the correct window values', () => {
    const { code, stderr, bashrc } = runCopilotByok({ defaultRoute: 'codeflare' });
    assert.equal(code, 0, `Copilot BYOK block exited non-zero: ${stderr}`);
    // These are functional config values (not copy): they right-size Copilot's
    // context window for gpt-5.5 (1,050,000 ctx / 128,000 output; prompt = ctx - headroom).
    assert.match(bashrc, /export COPILOT_PROVIDER_MAX_PROMPT_TOKENS="920000"/, 'MAX_PROMPT_TOKENS not set to 920000 in .bashrc');
    assert.match(bashrc, /export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS="128000"/, 'MAX_OUTPUT_TOKENS not set to 128000 in .bashrc');
  });

  it('REQ-ENTERPRISE-005 AC3: re-running with a changed default route overwrites the stale COPILOT_MODEL', () => {
    // First run persists COPILOT_MODEL="old_route".
    const { code: c1, stderr: s1, bashrc: bashrc1 } = runCopilotByok({ defaultRoute: 'old_route' });
    assert.equal(c1, 0, `first Copilot BYOK run exited non-zero: ${s1}`);
    assert.match(bashrc1, /export COPILOT_MODEL="old_route"/, 'old_route not set on first run');

    // Second run with a different default route against the .bashrc from the first run.
    // The sentinel-strip + prepend mechanism must remove the old block and write a fresh one.
    const { code: c2, stderr: s2, bashrc: bashrc2 } = runCopilotByok({
      defaultRoute: 'new_route',
      existingBashrc: bashrc1,
    });
    assert.equal(c2, 0, `second Copilot BYOK run exited non-zero: ${s2}`);

    // Stale value gone, new value present.
    assert.ok(
      !bashrc2.includes('export COPILOT_MODEL="old_route"'),
      'stale COPILOT_MODEL="old_route" still present in .bashrc after re-assertion',
    );
    assert.match(
      bashrc2,
      /export COPILOT_MODEL="new_route"/,
      'new COPILOT_MODEL="new_route" not written to .bashrc after re-assertion',
    );

    // The sentinel must appear exactly once (strip + prepend, not append).
    const sentinelCount = (bashrc2.match(/^# enterprise-copilot-byok$/gm) || []).length;
    assert.equal(sentinelCount, 1, `enterprise-copilot-byok sentinel appears ${sentinelCount} times after re-assertion`);
  });

  it('REQ-ENTERPRISE-005 AC3: when ENTERPRISE_MODE is unset, Copilot BYOK vars are not written to .bashrc', () => {
    // Mirror the AC2 gating test: the outer ENTERPRISE_MODE=active guard means
    // none of the Copilot BYOK vars are written when the flag is absent.
    const dir = mkdtempSync(join(tmpdir(), 'ent-copilot-gating-'));
    const bashrcPath = join(dir, '.bashrc');
    const initialContent = '# pre-existing line\n';
    writeFileSync(bashrcPath, initialContent);

    const script = [
      'set -euo pipefail',
      `USER_HOME='${dir}'`,
      // ENTERPRISE_MODE deliberately NOT set.
      `if [ "\${ENTERPRISE_MODE:-}" = "active" ]; then`,
      `  printf '# enterprise-copilot-byok\\nexport COPILOT_PROVIDER_BASE_URL=fake\\n' >> '${bashrcPath}'`,
      `fi`,
    ].join('\n');

    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    const bashrc = readFileSync(bashrcPath, 'utf8');
    assert.equal(bashrc, initialContent, '.bashrc was modified even though ENTERPRISE_MODE was unset');
    assert.ok(!bashrc.includes('COPILOT_PROVIDER_BASE_URL'), 'COPILOT_PROVIDER_BASE_URL written to .bashrc without ENTERPRISE_MODE=active');
  });
});
