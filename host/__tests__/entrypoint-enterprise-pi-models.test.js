// Regression test for the enterprise-mode Pi models.json build in entrypoint.sh.
//
// Bug (prod-down on every enterprise container): the models-array jq used
// `--arg def ... $def`, but `def` is a RESERVED jq keyword (function
// definition), so jq rejects `$def` with a compile error. Because the jq runs
// in an UNGUARDED command-substitution under `set -euo pipefail`, the failure
// aborted entrypoint.sh -> PID 1 exited -> the container crash-looped. Only
// enterprise was hit because the whole block is gated on ENTERPRISE_MODE=active.
//
// container-env-llm.test.ts already covers the WORKER fanning the route vars,
// but nothing ran the entrypoint jq against a real jq binary. This test does
// ("run the real thing" per tdd-discipline): extract the models.json build
// block and execute it with jq + `set -euo pipefail`, against the real
// configured catalog shape. Revert the fix (def back) and this test fails.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Extract the models.json build block (PI_MODELS_ARRAY + PI_PROVIDER_CONFIG +
// the models.json write) by its stable comment markers.
function extractModelsBlock() {
  const start = entrypoint.indexOf('# models.json: codeflare-gateway provider with ONE model per catalog route.');
  if (start === -1) throw new Error('models.json block start marker not found in entrypoint.sh');
  const end = entrypoint.indexOf('# settings.json: overwrite ONLY defaultProvider', start);
  if (end === -1) throw new Error('models.json block end marker not found in entrypoint.sh');
  return entrypoint.slice(start, end);
}

// Run the extracted block with the given catalog and return { code, modelsJson }.
function runBlock(catalogJson, defaultRoute, contextWindowsJson) {
  const block = extractModelsBlock();
  const dir = mkdtempSync(join(tmpdir(), 'ent-pi-models-'));
  const modelsPath = join(dir, 'models.json');
  const script = [
    'set -euo pipefail',
    `ENTERPRISE_ROUTE_CATALOG='${catalogJson}'`,
    `ENTERPRISE_DEFAULT_ROUTE='${defaultRoute}'`,
    ...(contextWindowsJson !== undefined ? [`ENTERPRISE_ROUTE_CONTEXT_WINDOWS='${contextWindowsJson}'`] : []),
    "ENTERPRISE_PLACEHOLDER_TOKEN='codeflare-enterprise'",
    "PI_GATEWAY_BASE_URL='https://api.openai.com/v1'",
    `PI_MODELS_JSON='${modelsPath}'`,
    block,
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  let modelsJson = null;
  if (res.status === 0) modelsJson = JSON.parse(readFileSync(modelsPath, 'utf8'));
  return { code: res.status, stderr: res.stderr, modelsJson };
}

describe('entrypoint enterprise Pi models.json build (REQ-ENTERPRISE-005)', () => {
  it('builds models.json with one model per catalog route under set -euo pipefail', () => {
    const catalog = ['general_usage', 'development', 'code_review', 'documentation'];
    const { code, stderr, modelsJson } = runBlock(JSON.stringify(catalog), 'general_usage');
    assert.equal(code, 0, `entrypoint enterprise block exited non-zero: ${stderr}`);
    const models = modelsJson.providers['codeflare-gateway'].models;
    assert.equal(models.length, catalog.length);
    assert.deepEqual(models.map((m) => m.id), catalog);
    for (const m of models) {
      assert.equal(m.reasoning, true);
      // With no per-route window configured, each model defaults to 256000
      // (DEFAULT_ROUTE_CONTEXT_WINDOW), not Pi's built-in 128k. Drop the contextWindow
      // field or its default and this fails.
      assert.equal(m.contextWindow, 256000);
    }
  });

  it('applies the per-route context window from ENTERPRISE_ROUTE_CONTEXT_WINDOWS, default 256000 for unlisted routes', () => {
    // REQ-ENTERPRISE-012: admin-configured per-route windows (e.g. a 1M-context BYOK
    // route) win; a route with no entry falls back to the 256000 default. Revert to a
    // hardcoded single window and the per-route value fails.
    const catalog = ['general_usage', 'development'];
    const windows = { general_usage: 1048576 };
    const { code, stderr, modelsJson } = runBlock(JSON.stringify(catalog), 'general_usage', JSON.stringify(windows));
    assert.equal(code, 0, `entrypoint block exited non-zero: ${stderr}`);
    const byId = Object.fromEntries(
      modelsJson.providers['codeflare-gateway'].models.map((m) => [m.id, m.contextWindow]),
    );
    assert.equal(byId.general_usage, 1048576, 'configured route uses its window');
    assert.equal(byId.development, 256000, 'unlisted route falls back to the default');
  });

  it('clears Pi auth.json to {} in enterprise so the model picker is routes-only', () => {
    // Routes-only picker: Pi lists a provider in /model only when it has auth.
    // codeflare-gateway authenticates via the models.json apiKey placeholder, NOT
    // auth.json, so emptying auth.json drops every built-in provider (e.g. the seeded
    // openai-codex) from the picker. Extract the real entrypoint line and run it
    // against a seeded auth.json. Remove the line and this fails.
    const clearLine = entrypoint
      .split('\n')
      .find((l) => l.includes(`echo '{}' > "$USER_HOME/.pi/agent/auth.json"`));
    assert.ok(clearLine, 'auth.json clear line not found in entrypoint.sh');
    const dir = mkdtempSync(join(tmpdir(), 'ent-pi-auth-'));
    const script = [
      'set -euo pipefail',
      `USER_HOME='${dir}'`,
      'mkdir -p "$USER_HOME/.pi/agent"',
      `echo '{"openai-codex":{"token":"seeded"}}' > "$USER_HOME/.pi/agent/auth.json"`,
      clearLine.trim(),
    ].join('\n');
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, `auth.json clear exited non-zero: ${res.stderr}`);
    const authJson = JSON.parse(readFileSync(join(dir, '.pi/agent/auth.json'), 'utf8'));
    assert.deepEqual(authJson, {}, 'auth.json must be emptied so no built-in provider stays authed');
  });

  it('falls back to the default route when the catalog is empty (provider never has zero models)', () => {
    const { code, modelsJson } = runBlock('[]', 'codeflare');
    assert.equal(code, 0);
    const models = modelsJson.providers['codeflare-gateway'].models;
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'codeflare');
  });

  it('entrypoint.sh uses no jq --arg/--argjson named after a reserved jq keyword', () => {
    // Version-robust static guard: a reserved-keyword arg name ($def, $if, $as, …)
    // is a jq compile error and, in an unguarded command-substitution under
    // set -e, crashes the container. Keep this class out of entrypoint.sh.
    const KEYWORDS = [
      'def', 'if', 'then', 'elif', 'else', 'end', 'as', 'reduce', 'foreach',
      'try', 'catch', 'import', 'include', 'label', 'and', 'or', 'not',
    ];
    // Strip full-line `#` comments first, so a comment that mentions the bad
    // pattern (e.g. this fix's own explanatory note about `--arg def`) does not
    // trip the guard — we only want to catch it in actual shell commands.
    const code = entrypoint.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    const re = new RegExp(`--arg(?:json)?\\s+(${KEYWORDS.join('|')})\\b`, 'g');
    const hits = code.match(re) || [];
    assert.deepEqual(hits, [], `reserved-keyword jq arg name(s) in entrypoint.sh: ${hits.join(', ')}`);
  });
});
