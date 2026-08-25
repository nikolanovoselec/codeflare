import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GATE = join(ROOT, 'scripts', 'ci', 'image-prerequisite-gate.sh');

function runGate(scanStatus, sbomStatus, wranglerStatus) {
  return spawnSync('bash', ['-c', `
    set -u
    source "$1"
    (exit "$2") & scan_pid=$!
    (exit "$3") & sbom_pid=$!
    (exit "$4") & wrangler_pid=$!
    wait_for_image_prerequisites "$scan_pid" "$sbom_pid" "$wrangler_pid"
  `, 'image-prerequisite-gate', GATE, String(scanStatus), String(sbomStatus), String(wranglerStatus)], {
    encoding: 'utf8',
  });
}

describe('REQ-OPS-052: concurrent image security preparation', () => {
  it('blocks publication when any concurrent image prerequisite fails', () => {
    assert.equal(runGate(0, 0, 0).status, 0);
    assert.equal(runGate(17, 0, 0).status, 17);
    assert.equal(runGate(0, 19, 0).status, 19);
    assert.equal(runGate(0, 0, 23).status, 23);
    assert.equal(runGate(17, 19, 23).status, 17);
  });

  it('fails closed when invoked without prerequisite process IDs', () => {
    const result = spawnSync('bash', ['-c', 'source "$1"; wait_for_image_prerequisites', 'image-prerequisite-gate', GATE], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires at least one PID/);
  });
});
