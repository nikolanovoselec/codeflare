// REQ-AGENT-076 AC5: Pi's web_search workflow defaults to auto-summary so it
// never reaches pi-web-access's interactive browser-curator fallback, which
// cannot function in this headless container.
//
// "Run the real thing" per tdd-discipline.md: extract the real web-search
// block from entrypoint.sh and execute it against a fixture $USER_HOME,
// asserting on the actual written JSON content -- not on entrypoint.sh's
// source text.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Pull the standalone web-search block (assignment through its closing `fi`)
// -- it is inline MAIN EXECUTION code, not a function, so it is sliced by
// anchor text rather than extracted as a named function body.
function extractWebSearchBlock() {
  const marker = 'PI_WEB_SEARCH_JSON="$USER_HOME/.pi/web-search.json"';
  const ifStart = entrypoint.indexOf(marker);
  if (ifStart === -1) {
    throw new Error('web-search block PI_WEB_SEARCH_JSON marker not found in entrypoint.sh');
  }
  const end = entrypoint.indexOf('\nfi\n', ifStart);
  if (end === -1) {
    throw new Error('web-search block closing fi not found in entrypoint.sh');
  }
  return entrypoint.slice(ifStart, end + '\nfi'.length);
}

function runBlock(userHome) {
  const script = `
set -euo pipefail
USER_HOME="${userHome}"
${extractWebSearchBlock()}
`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`harness bash exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  }
  return result;
}

describe('entrypoint.sh Pi web-search workflow default', () => {
  it('writes auto-summary when absent', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'web-search-'));
    runBlock(userHome);
    const written = JSON.parse(readFileSync(join(userHome, '.pi', 'web-search.json'), 'utf8'));
    assert.deepEqual(written, { workflow: 'auto-summary' });
  });

  it('does not overwrite an existing file', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'web-search-'));
    mkdirSync(join(userHome, '.pi'), { recursive: true });
    const configPath = join(userHome, '.pi', 'web-search.json');
    const userChoice = JSON.stringify({ workflow: 'summary-review' });
    writeFileSync(configPath, userChoice);
    runBlock(userHome);
    assert.equal(readFileSync(configPath, 'utf8'), userChoice);
  });
});
