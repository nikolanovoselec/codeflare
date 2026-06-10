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
function runBlock(catalogJson, defaultRoute) {
  const block = extractModelsBlock();
  const dir = mkdtempSync(join(tmpdir(), 'ent-pi-models-'));
  const modelsPath = join(dir, 'models.json');
  const script = [
    'set -euo pipefail',
    `ENTERPRISE_ROUTE_CATALOG='${catalogJson}'`,
    `ENTERPRISE_DEFAULT_ROUTE='${defaultRoute}'`,
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
    for (const m of models) assert.equal(m.reasoning, true);
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
