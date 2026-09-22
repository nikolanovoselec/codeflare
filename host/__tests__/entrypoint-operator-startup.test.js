/** REQ-OPERATOR-022: restricted startup cannot enter whole-home restore/baseline paths. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(root, 'entrypoint.sh'), 'utf8');
function extract(name) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => new RegExp(`^${name}\\(\\) \\{`).test(line));
  const end = lines.findIndex((line, index) => index > start && line === '}');
  if (start < 0 || end < 0) throw new Error(`missing ${name}`);
  return lines.slice(start, end + 1).join('\n');
}
function run(operator) {
  const script = [
    'set -euo pipefail',
    'LOG=""',
    'run_operator_startup() { LOG="${LOG}operator,"; }',
    'run_initial_r2_restore() { LOG="${LOG}restore,"; }',
    'run_post_restore_startup() { LOG="${LOG}post,"; }',
    'complete_managed_curation_startup() { LOG="${LOG}complete,"; }',
    `CODEFLARE_OPERATOR_SESSION='${operator ? 'true' : ''}'`,
    extract('run_managed_curation_startup'),
    'run_managed_curation_startup',
    'printf "%s" "$LOG"',
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('REQ-OPERATOR-022: operator startup selects only restricted initialization', () => {
  const result = run(true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'operator,');
});

test('REQ-OPERATOR-022: ordinary startup retains restore, post-restore and completion flow', () => {
  const result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'restore,post,complete,');
});

function runAttachmentRestore({ portBound, nodeResult = 0 }) {
  const script = [
    'set -euo pipefail',
    'CODEFLARE_OPERATOR_ATTACHMENTS=fixture',
    `PORT_BOUND=${portBound}`,
    'RCLONE_CONFIG_RESULT=0',
    'FLAG=$(mktemp -u)',
    'CODEFLARE_INIT_FLAG_FILE=$FLAG',
    `node() { [ ! -e "$CODEFLARE_INIT_FLAG_FILE" ] || return 90; sleep 0.1; return ${nodeResult}; }`,
    extract('restore_operator_attachments'),
    'restore_operator_attachments',
    'test ! -e "$CODEFLARE_INIT_FLAG_FILE"',
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('REQ-OPERATOR-052: attachment restore requires confirmed early bind and keeps readiness closed', () => {
  const unbound = runAttachmentRestore({ portBound: 0 });
  assert.notEqual(unbound.status, 0);
  assert.match(unbound.stderr, /requires a bound terminal port/);
  const delayed = runAttachmentRestore({ portBound: 1 });
  assert.equal(delayed.status, 0, delayed.stderr);
});

test('REQ-OPERATOR-052: failed attachment restore cannot open readiness', () => {
  const failed = runAttachmentRestore({ portBound: 1, nodeResult: 7 });
  assert.equal(failed.status, 7, failed.stderr);
});
