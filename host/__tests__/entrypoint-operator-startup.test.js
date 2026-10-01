/** REQ-OPERATOR-022: restricted startup cannot enter whole-home restore/baseline paths. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
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
    'restore_operator_attachments() { LOG="${LOG}attachments,"; }',
    extract('run_operator_attachment_startup'),
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
  assert.equal(result.stdout, 'attachments,operator,');
});

test('REQ-OPERATOR-022: ordinary startup retains restore, post-restore and completion flow', () => {
  const result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'restore,post,complete,');
});

test('REQ-OPERATOR-053: generated Pi inventory excludes independently loaded local and remote Review', () => {
  const home = mkdtempSync(join(tmpdir(), 'operator-review-settings-'));
  try {
    const agentDir = join(home, '.pi/agent');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true });
    writeFileSync(join(agentDir, 'extensions/operator-review-selector.ts'), 'export default () => {}');
    writeFileSync(join(agentDir, 'extensions/operator-review-remote.ts'), 'export default () => {}');
    const local = join(agentDir, 'extensions/review-enforcement.ts');
    const remote = join(agentDir, 'extensions/operator-review-remote.ts');
    const settingsPath = join(agentDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ extensions: [`+${local}`, `+${remote}`] }));
    const start = source.indexOf('warm_pi_npm_dependencies() {');
    const end = source.indexOf('\n}\n\nupdate_pi_and_codex_when_fast_start_disabled()', start);
    const warm = source.slice(start, end + 2);
    const configStart = source.indexOf('configure_pi_packages_and_review_inventory() {');
    const configure = source.slice(configStart, start);
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${configure}\n${warm}\nwarm_pi_npm_dependencies`],
      { encoding: 'utf8', env: { ...process.env, USER_HOME: home, PI_NPM_PRESEED: join(home, 'missing') } });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(config.extensions.includes(`-${local}`), true);
    assert.equal(config.extensions.includes(`-${remote}`), true);
    assert.equal(config.extensions.includes(`+${local}`), true);
    assert.equal(config.extensions.includes(`+${remote}`), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function runAttachmentRestore({ portBound, nodeResult = 0 }) {
  const script = [
    'set -euo pipefail',
    'CODEFLARE_OPERATOR_ATTACHMENTS=fixture',
    `PORT_BOUND=${portBound}`,
    'RCLONE_CONFIG_RESULT=0',
    'FLAG=$(mktemp -u)',
    'CODEFLARE_INIT_FLAG_FILE=$FLAG',
    "trap 'rc=$?; if [ -e \"$CODEFLARE_INIT_FLAG_FILE\" ]; then printf \"ready-present\"; else printf \"ready-absent\"; fi; exit \"$rc\"' EXIT",
    'LOG=""',
    `node() { LOG="${'${LOG}'}restore-start,"; [ ! -e "$CODEFLARE_INIT_FLAG_FILE" ] || return 90; sleep 0.1; return ${nodeResult}; }`,
    'run_operator_startup() { LOG="${LOG}ready,"; touch "$CODEFLARE_INIT_FLAG_FILE"; }',
    extract('restore_operator_attachments'),
    extract('run_operator_attachment_startup'),
    'run_operator_attachment_startup',
    'printf "%s" "$LOG"',
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('REQ-OPERATOR-052: attachment restore requires confirmed early bind and keeps readiness closed', () => {
  const unbound = runAttachmentRestore({ portBound: 0 });
  assert.notEqual(unbound.status, 0);
  assert.match(unbound.stderr, /requires a bound terminal port/);
  const delayed = runAttachmentRestore({ portBound: 1 });
  assert.equal(delayed.status, 0, delayed.stderr);
  assert.equal(delayed.stdout, 'restore-start,ready,ready-present');
});

test('REQ-OPERATOR-052: failed attachment restore cannot open readiness', () => {
  const failed = runAttachmentRestore({ portBound: 1, nodeResult: 7 });
  assert.equal(failed.status, 7, failed.stderr);
  assert.equal(failed.stdout, 'ready-absent');
});

test('REQ-ENTERPRISE-088 AC7: real Operator startup excludes human authentication and inline provider secrets', () => {
  const home = mkdtempSync(join(tmpdir(), 'operator-personal-auth-'));
  try {
    const agentDir = join(home, '.pi/agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'synthetic-owner-secret' } }));
    const gateway = { apiKey: 'codeflare-enterprise', models: [{ id: 'sanctioned' }] };
    const humanGateway = { ...gateway, apiKey: 'synthetic-managed-alias-secret', headers: { authorization: 'synthetic-header-secret' } };
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'codeflare-gateway': humanGateway, openai: { apiKey: 'synthetic-inline-secret' } } }));
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    // System materialization is unrelated platform I/O. Remap the validated
    // absolute Operator namespace into this temporary filesystem, retaining the
    // real configuration validator, install/copy and authentication behavior.
    const script = `set -euo pipefail
validate_coding_agent_selection() { :; }
update_sync_status() { :; }
run_post_restore_startup() { :; }
node() {
  if [ "$1" = /opt/codeflare/scripts/materialize-operator-inputs.mjs ]; then return 0; fi
  command node "$@" | sed "s|/home/user/.codeflare/operators|$USER_HOME/.codeflare/operators|"
}
${extract('run_operator_startup')}
run_operator_startup`;
    const start = routing => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, USER_HOME: home,
      CODEFLARE_INIT_FLAG_FILE: join(home, 'initialized'),
      PI_PROVIDER_CONFIG: routing,
      CODEFLARE_OPERATOR_PI_CONFIG: JSON.stringify({ schemaVersion: 1, activityId: 'activity', sessionId: 'session', root: '/home/user/.codeflare/operators/activity' }),
      CODEFLARE_OPERATOR_SYNC_CONFIG: JSON.stringify({ schemaVersion: 1, activityId: 'activity', sessionId: 'session', root: '/home/user/Operators' }) } });
    // Readiness is the startup contract: absent/malformed trusted publication
    // cannot use the human's existing managed alias as a credential fallback.
    for (const unavailable of ['', ' ', '{}', 'null', '{malformed']) {
      const failed = start(unavailable);
      assert.notEqual(failed.status, 0, `Unavailable routing ${JSON.stringify(unavailable)}: ${failed.stderr}`);
      assert.equal(existsSync(join(home, 'initialized')), false);
    }
    const result = start(JSON.stringify({ providers: { 'codeflare-gateway': gateway } }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(home, 'initialized')), true);
    const isolated = join(home, '.codeflare/operators/activity/agent');
    assert.deepEqual(JSON.parse(readFileSync(join(isolated, 'auth.json'), 'utf8')), {});
    assert.deepEqual(JSON.parse(readFileSync(join(isolated, 'models.json'), 'utf8')), { providers: { 'codeflare-gateway': gateway } });
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8')), { anthropic: { type: 'api_key', key: 'synthetic-owner-secret' } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
