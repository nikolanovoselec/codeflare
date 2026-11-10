import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const selectorPath = join(root, 'scripts/ci/coding-agent-selection.mjs');
const source = readFileSync(join(root, 'entrypoint.sh'), 'utf8');
const lines = source.split('\n');
const companionDeclaration = lines.find((line) => line.startsWith('readonly -a IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS='));
assert.ok(companionDeclaration, 'image-owned companion declaration missing');
const companionResult = spawnSync('bash', ['-c', `${companionDeclaration}\nprintf '%s\\n' "\${IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS[@]}"`], { encoding: 'utf8' });
assert.equal(companionResult.status, 0, companionResult.stderr);
const imageOwnedCompanions = companionResult.stdout.trim().split('\n').filter(Boolean);
const retiredExtensions = ['review-job-helpers.ts', 'review-jobs.ts', 'review-lane-guards.ts'];

function functionSource(name) {
  const start = lines.findIndex((line) => line === `${name}() {`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  assert.notEqual(start, -1, `${name} missing`);
  assert.notEqual(end, -1, `${name} terminator missing`);
  return lines.slice(start, end + 1).join('\n');
}

function productionInvocation(name) {
  const invocation = lines.find((line) => line === name);
  assert.equal(invocation, name, `${name} production invocation missing`);
  return invocation;
}

const validateSelection = functionSource('validate_coding_agent_selection');
const codingAgentSelected = functionSource('coding_agent_is_selected');
const layDown = functionSource('lay_down_agent_seed_preseed');
const relay = functionSource('relay_managed_pi_extensions');
const initialRestore = functionSource('run_initial_r2_restore');
const completeStartup = functionSource('complete_managed_curation_startup');
const managedStartup = functionSource('run_managed_curation_startup');
const managedStartupInvocation = productionInvocation('run_managed_curation_startup');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'managed-entrypoint-'));
  const home = join(root, 'home');
  const bake = join(root, 'bake');
  const warm = join(root, 'warm');
  mkdirSync(join(home, '.pi/agent/extensions'), { recursive: true });
  mkdirSync(join(bake, 'default/.claude'), { recursive: true });
  mkdirSync(join(bake, 'default/.pi/agent/extensions'), { recursive: true });
  mkdirSync(warm, { recursive: true });
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(join(runtimeRoot, 'sync'), { recursive: true });
  writeFileSync(join(bake, 'default/.claude/company.md'), 'baked claude');
  writeFileSync(join(bake, 'default/.pi/agent/extensions/company.ts'), 'baked pi');
  writeFileSync(join(home, '.pi/agent/extensions/codeflare.ts'), 'restored release');
  writeFileSync(join(warm, 'codeflare.ts'), 'baked image');
  writeFileSync(join(warm, 'warm-only.ts'), 'unfiltered image only');
  for (const name of retiredExtensions) {
    writeFileSync(join(home, '.pi/agent/extensions', name), `restored release ${name}`);
  }
  for (const companion of imageOwnedCompanions) {
    writeFileSync(join(warm, companion), `image-owned ${companion}`);
  }
  return { root, home, bake, warm, runtimeRoot, events: join(root, 'events') };
}

function runStartup(remoteCurationActive, codingAgents = 'claude-code,codex,copilot,antigravity,opencode,pi') {
  const f = fixture();
  const result = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    `USER_HOME='${f.home}'`,
    `USER_WORKSPACE='${join(f.home, 'workspace')}'`,
    `AGENT_SEED_BAKE_DIR='${f.bake}'`,
    `PI_WARM_EXTENSIONS_DIR='${f.warm}'`,
    `EVENTS='${f.events}'`,
    `CODING_AGENT_SELECTOR='${selectorPath}'`,
    `CODEFLARE_CODING_AGENTS='${codingAgents}'`,
    "R2_SSE_DISABLED='true'",
    "RCLONE_CONFIG_RESULT='0'",
    "ENTERPRISE_MODE=''",
    "SYNC_ERROR='null'",
    "SESSION_MODE='default'",
    `REMOTE_CURATION_ACTIVE='${remoteCurationActive ? 'true' : 'false'}'`,
    'cp() {',
    '  case "$*" in',
    '    *"$AGENT_SEED_BAKE_DIR"/*) echo laydown >> "$EVENTS" ;;',
    '    *"$PI_WARM_EXTENSIONS_DIR"/*) echo relay >> "$EVENTS" ;;',
    '  esac',
    '  command cp "$@"',
    '}',
    'update_sync_status() { :; }',
    'initial_sync_from_r2() { echo initial >> "$EVENTS"; }',
    'prepare_managed_resource_filter() { echo prepare-filter >> "$EVENTS"; }',
    'release_agent_pty_after_fast_start_updates() { echo cleanup >> "$EVENTS"; }',
    'establish_bisync_baseline() { echo baseline >> "$EVENTS"; }',
    'init_user_vault() { :; }',
    'start_sync_daemon() { :; }',
    'start_vault_monitor_daemon() { :; }',
    'start_silverbullet_supervisor() { :; }',
    'start_openvscode_supervisor() { :; }',
    'run_post_restore_startup() { echo post-restore >> "$EVENTS"; }',
    'renice() { :; }',
    'ionice() { :; }',
    validateSelection,
    codingAgentSelected,
    layDown,
    companionDeclaration,
    relay,
    initialRestore,
    completeStartup,
    managedStartup,
    managedStartupInvocation,
    'wait',
  ].join('\n')], {
    encoding: 'utf8',
    env: { ...process.env, CODEFLARE_RUNTIME_ROOT: f.runtimeRoot },
  });
  return {
    ...f,
    result,
    companyFile: join(f.home, '.claude/company.md'),
    piCompanyFile: join(f.home, '.pi/agent/extensions/company.ts'),
    extensionFile: join(f.home, '.pi/agent/extensions/codeflare.ts'),
    companionFiles: imageOwnedCompanions.map((companion) => ({
      content: `image-owned ${companion}`,
      destination: join(f.home, '.pi/agent/extensions', companion),
    })),
  };
}

describe('managed curation entrypoint behavior', () => {
  it('REQ-STOR-031 AC1/AC2/AC7: restores managed content and declared image companions before baseline', () => {
    const run = runStartup(true);

    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(existsSync(run.companyFile), false);
    assert.equal(readFileSync(run.extensionFile, 'utf8'), 'restored release');
    assert.equal(existsSync(run.piCompanyFile), false, 'remote curation must not backfill from the mode bake');
    assert.equal(existsSync(join(run.home, '.pi/agent/extensions/warm-only.ts')), false,
      'undeclared image files must not be restored as companions');
    for (const name of retiredExtensions) {
      assert.equal(readFileSync(join(run.home, '.pi/agent/extensions', name), 'utf8'),
        `restored release ${name}`, 'remote relay must not apply baked-only local pruning');
    }
    for (const companion of run.companionFiles) {
      assert.equal(readFileSync(companion.destination, 'utf8'), companion.content);
    }
    // Relay is a phase, not a fixed number of file-copy calls. Every declared
    // companion's bytes are checked above; all relay writes must precede cleanup.
    const events = readFileSync(run.events, 'utf8').trim().split('\n');
    assert.deepEqual(events.filter(event => event !== 'relay'), [
      'initial', 'post-restore', 'prepare-filter', 'cleanup', 'baseline',
    ]);
    assert.ok(events.indexOf('relay') > events.indexOf('prepare-filter'));
    assert.ok(events.lastIndexOf('relay') < events.indexOf('cleanup'));
  });

  it('executes the reachable baked restore, relay, cleanup, and baseline in order when curation is disabled', () => {
    const run = runStartup(false);

    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(readFileSync(run.companyFile, 'utf8'), 'baked claude');
    assert.equal(readFileSync(run.extensionFile, 'utf8'), 'baked image');
    assert.deepEqual(readFileSync(run.events, 'utf8').trim().split('\n'), [
      'laydown',
      'laydown',
      'initial',
      'post-restore',
      'prepare-filter',
      'relay',
      'cleanup',
      'baseline',
    ]);
  });

  it('REQ-STOR-024: lays down only selected agent roots and skips the Pi relay when Pi is inactive', () => {
    const run = runStartup(false, 'claude-code');

    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(readFileSync(run.companyFile, 'utf8'), 'baked claude');
    assert.equal(existsSync(run.piCompanyFile), false);
    assert.equal(readFileSync(run.extensionFile, 'utf8'), 'restored release');
    assert.equal(readFileSync(run.events, 'utf8').trim().split('\n').includes('relay'), false);
  });

  it('REQ-STOR-024: rejects invalid explicit selection before initial restore or baseline work', () => {
    const run = runStartup(false, 'pi,unknown');

    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /unknown coding agent.*unknown/i);
    assert.equal(existsSync(run.events), false);
    assert.equal(existsSync(run.companyFile), false);
    assert.equal(existsSync(run.piCompanyFile), false);
  });
});

describe('REQ-STOR-031 / REQ-MEM-030: advanced trim dependency delivery', () => {
  const main = 'active-session-transcript-trimming.ts';
  const helper = 'transcript-trim/engine.mjs';
  function runRelay(t, { mode = 'advanced', remote = false, returning = false, missing = false } = {}) {
    const f = fixture();
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    const dest = join(f.home, '.pi/agent/extensions');
    for (const base of [f.warm, join(f.bake, 'advanced/.pi/agent/extensions')]) {
      mkdirSync(join(base, 'transcript-trim'), { recursive: true });
      writeFileSync(join(base, main), "export { value } from './transcript-trim/engine.mjs';\n");
      if (!missing) writeFileSync(join(base, helper), 'export const value = 42;\n');
    }
    if (returning) {
      mkdirSync(join(dest, 'transcript-trim'), { recursive: true });
      writeFileSync(join(dest, main), 'export const value = 7;\n');
      writeFileSync(join(dest, helper), 'export const value = 7;\n');
    }
    const result = spawnSync('bash', ['-c', `set -eu
USER_HOME=${JSON.stringify(f.home)}
PI_WARM_EXTENSIONS_DIR=${JSON.stringify(f.warm)}
AGENT_SEED_BAKE_DIR=${JSON.stringify(f.bake)}
CODEFLARE_RUNTIME_ROOT=${JSON.stringify(f.runtimeRoot)}
SESSION_MODE=${mode}
REMOTE_CURATION_ACTIVE=${remote}
coding_agent_is_selected() { return 0; }
${companionDeclaration}
${relay}
relay_managed_pi_extensions
`], { encoding: 'utf8' });
    return { ...f, dest, result };
  }
  for (const returning of [false, true]) it(`delivers an importable helper before advanced extension ${returning ? 'relay' : 'backfill'}`, t => {
    const f = runRelay(t, { returning });
    assert.equal(f.result.status, 0, f.result.stderr);
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', 'const m=await import(process.argv[1]); process.stdout.write(String(m.value));', join(f.dest, main)], { encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '42');
  });
  it('does not add advanced trimmer assets to default mode', t => {
    const f = runRelay(t, { mode: 'default' });
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(existsSync(join(f.dest, main)), false);
    assert.equal(existsSync(join(f.dest, helper)), false);
  });
  it('preserves release-owned extension and helper bytes under remote curation', t => {
    const f = runRelay(t, { remote: true, returning: true });
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(readFileSync(join(f.dest, main), 'utf8'), 'export const value = 7;\n');
    assert.equal(readFileSync(join(f.dest, helper), 'utf8'), 'export const value = 7;\n');
  });
  it('does not replace a missing release-owned helper with image bytes', t => {
    const f = runRelay(t, { remote: true });
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(existsSync(join(f.dest, helper)), false);
  });
  it('leaves the existing extension unchanged when the image helper is missing', t => {
    const f = runRelay(t, { returning: true, missing: true });
    assert.notEqual(f.result.status, 0);
    assert.equal(readFileSync(join(f.dest, main), 'utf8'), 'export const value = 7;\n');
  });
});
