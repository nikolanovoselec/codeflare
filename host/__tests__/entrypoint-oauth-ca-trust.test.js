// Tests for REQ-AGENT-078 AC6: non-enterprise OAuth intercept-CA trust (entrypoint.sh).
//
// A non-enterprise "Connect to Cloudflare" OAuth session wires interceptOutboundHttps
// for api.cloudflare.com / gateway.ai.cloudflare.com, so the platform mounts its
// intercept CA and TLS-terminates those calls. Without trusting that CA the agents'
// HTTPS clients (Node/wrangler/curl) reject the connection with SELF_SIGNED_CERT_IN_CHAIN.
// entrypoint.sh trusts it in a block SEPARATE from (and not touching) the enterprise
// CA-trust — gated on `ENTERPRISE_MODE != active` AND the CA file's presence.
//
// Strategy mirrors entrypoint-enterprise-ca-copilot.test.js: extract the real block by
// stable sentinel markers and run it with `bash` in a tmpdir. `cp` and
// `update-ca-certificates` are shimmed to no-ops on PATH so the block's system-store
// install has no side effect (and needs no root) — only the .bashrc write is asserted.
// "Run the real thing": if the block is gutted, renamed, or its gate weakened, these fail.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

/**
 * Extract the non-enterprise OAuth CA-trust block from entrypoint.sh.
 *
 * Starts at the gate `if [ "${ENTERPRISE_MODE:-}" != "active" ] && [ -f "$CF_OAUTH_CA_SRC" ]`
 * (unique in the file) and ends at its closing `fi` — the `\n    fi\nfi\n` that closes the
 * inner grep-guard then the outer gate. The `CF_OAUTH_CA_SRC=` assignment above the gate is
 * NOT included, so the harness injects CF_OAUTH_CA_SRC via the environment.
 */
function extractOAuthCaBlock() {
  const startMarker = 'if [ "${ENTERPRISE_MODE:-}" != "active" ] && [ -f "$CF_OAUTH_CA_SRC" ]; then';
  const start = entrypoint.indexOf(startMarker);
  if (start === -1) throw new Error('OAuth CA-trust gate not found in entrypoint.sh');
  const endMarker = '\n    fi\nfi\n';
  const end = entrypoint.indexOf(endMarker, start);
  if (end === -1) throw new Error('OAuth CA-trust closing fi not found in entrypoint.sh');
  return entrypoint.slice(start, end + endMarker.length);
}

/**
 * Run the extracted OAuth CA-trust block.
 *
 * @param enterpriseMode  value for ENTERPRISE_MODE; undefined → var left unset
 * @param caPresent       whether the mounted intercept CA file exists
 * @param existingBashrc  pre-existing .bashrc content (for idempotency)
 * Returns { code, stderr, bashrc, caPath }.
 */
function runOAuthCaTrust({ enterpriseMode = undefined, caPresent = true, existingBashrc = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-ca-'));
  const bashrcPath = join(dir, '.bashrc');
  writeFileSync(bashrcPath, existingBashrc);

  // The mounted intercept CA — created only when caPresent, so the `-f` gate can be exercised.
  const caPath = join(dir, 'cloudflare-containers-ca.crt');
  if (caPresent) writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');

  // Shim cp + update-ca-certificates to no-ops so the system-store install is inert
  // (no root needed, no CI trust-store pollution). Only the .bashrc write is under test.
  const shimDir = join(dir, 'shim');
  mkdirSync(shimDir);
  for (const name of ['cp', 'update-ca-certificates']) {
    const p = join(shimDir, name);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    chmodSync(p, 0o755);
  }

  const block = extractOAuthCaBlock();
  const script = [
    'set -uo pipefail',
    `export PATH='${shimDir}':"$PATH"`,
    `CF_OAUTH_CA_SRC='${caPath}'`,
    `USER_HOME='${dir}'`,
    enterpriseMode !== undefined ? `ENTERPRISE_MODE='${enterpriseMode}'` : '',
    block,
  ].join('\n');

  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const bashrc = existsSync(bashrcPath) ? readFileSync(bashrcPath, 'utf8') : '';
  return { code: res.status, stderr: res.stderr, bashrc, caPath };
}

describe('REQ-AGENT-078 AC6: non-enterprise OAuth intercept-CA trust (entrypoint.sh)', () => {
  it('non-enterprise + CA mounted: three CA env var names are exported to .bashrc', () => {
    const { code, stderr, bashrc } = runOAuthCaTrust();
    assert.equal(code, 0, `OAuth CA-trust block exited non-zero: ${stderr}`);
    // Gut-check: rename any export in entrypoint.sh and this fails.
    assert.match(bashrc, /export NODE_EXTRA_CA_CERTS=/, 'NODE_EXTRA_CA_CERTS not exported in .bashrc');
    assert.match(bashrc, /export SSL_CERT_FILE=/, 'SSL_CERT_FILE not exported in .bashrc');
    assert.match(bashrc, /export REQUESTS_CA_BUNDLE=/, 'REQUESTS_CA_BUNDLE not exported in .bashrc');
    assert.match(bashrc, /# cf-ca-trust/, 'cf-ca-trust sentinel not written to .bashrc');
  });

  it('non-enterprise + CA mounted: NODE_EXTRA_CA_CERTS points at the mounted CA path', () => {
    const { code, stderr, bashrc, caPath } = runOAuthCaTrust();
    assert.equal(code, 0, `OAuth CA-trust block exited non-zero: ${stderr}`);
    // Functional contract: the value must be the mounted containers-CA path — a wrong/empty
    // path leaves agents unable to validate the intercepted api.cloudflare.com TLS.
    assert.match(
      bashrc,
      new RegExp(`export NODE_EXTRA_CA_CERTS="${caPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      `NODE_EXTRA_CA_CERTS in .bashrc does not point at the mounted CA (${caPath})`,
    );
  });

  it('non-enterprise + CA mounted: prepend is idempotent — running twice does not duplicate', () => {
    const { code: c1, stderr: s1, bashrc: bashrc1 } = runOAuthCaTrust();
    assert.equal(c1, 0, `first OAuth CA-trust run exited non-zero: ${s1}`);
    assert.equal((bashrc1.match(/# cf-ca-trust/g) || []).length, 1, 'expected 1 cf-ca-trust sentinel after first run');

    const { code: c2, stderr: s2, bashrc: bashrc2 } = runOAuthCaTrust({ existingBashrc: bashrc1 });
    assert.equal(c2, 0, `second OAuth CA-trust run exited non-zero: ${s2}`);
    assert.equal((bashrc2.match(/# cf-ca-trust/g) || []).length, 1, 'idempotency broken: sentinel duplicated');
    assert.equal(
      (bashrc2.match(/export NODE_EXTRA_CA_CERTS=/g) || []).length,
      1,
      'idempotency broken: NODE_EXTRA_CA_CERTS exported more than once',
    );
  });

  it('enterprise mode: block is SKIPPED (enterprise uses its own CA-trust; this must not double-fire)', () => {
    const initial = '# pre-existing line\n';
    const { code, stderr, bashrc } = runOAuthCaTrust({ enterpriseMode: 'active', existingBashrc: initial });
    assert.equal(code, 0, `block exited non-zero under ENTERPRISE_MODE=active: ${stderr}`);
    assert.equal(bashrc, initial, '.bashrc was modified in enterprise mode — the non-enterprise block fired when it must not');
    assert.ok(!bashrc.includes('# cf-ca-trust'), 'cf-ca-trust written under ENTERPRISE_MODE=active');
  });

  it('CA not mounted: block is SKIPPED (no interception → nothing to trust)', () => {
    const initial = '# pre-existing line\n';
    const { code, stderr, bashrc } = runOAuthCaTrust({ caPresent: false, existingBashrc: initial });
    assert.equal(code, 0, `block exited non-zero with CA absent: ${stderr}`);
    assert.equal(bashrc, initial, '.bashrc was modified even though the intercept CA file is absent');
    assert.ok(!bashrc.includes('# cf-ca-trust'), 'cf-ca-trust written with no mounted CA');
  });
});
