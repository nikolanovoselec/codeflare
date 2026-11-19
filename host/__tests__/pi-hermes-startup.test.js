// REQ-MEM-035 AC1–4 (startup subset). Execute the real entrypoint helper;
// package loading, eager SQLite reconciliation and request context belong to
// their integration suites. In particular, this does not claim REQ-MEM-036.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = resolve(dirname(fileURLToPath(import.meta.url)), '../../entrypoint.sh');
const canonicalFiles = [
  'Vault/Memory/USER.md',
  'Vault/Memory/MEMORY.md',
  'Vault/Memory/failures.md',
  'Vault/Memory/Projects/workspace/MEMORY.md',
];
const configFile = '.pi/agent/hermes-memory-config.json';

// Same top-level-function/heredoc extraction as entrypoint-managed-curation.
// Ignore embedded JS/Python closing braces rather than truncating the helper.
function functionSource(name) {
  const lines = readFileSync(entrypoint, 'utf8').split('\n');
  const start = lines.findIndex(line => line === `${name}() {`);
  if (start < 0) throw new Error(`Missing entrypoint function ${name}`);
  let heredoc;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (heredoc) {
      if (line.replace(/^\t+/, '') === heredoc) heredoc = undefined;
      continue;
    }
    const marker = line.match(/<<-?\s*['"]?([A-Za-z_]\w*)['"]?/);
    if (marker) heredoc = marker[1];
    else if (line === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`Unterminated entrypoint function ${name}`);
}

function put(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-hermes-startup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home with spaces');
  const runtime = join(root, 'runtime');
  mkdirSync(join(home, 'workspace'), { recursive: true });
  mkdirSync(join(runtime, 'sync'), { recursive: true });
  return { root, home, runtime };
}

function run(fx, { mode = 'advanced', explicitHome = true } = {}) {
  return spawnSync('bash', ['-c', [
    'set -euo pipefail',
    functionSource('configure_pi_hermes_memory'),
    explicitHome ? 'configure_pi_hermes_memory "$USER_HOME"' : 'configure_pi_hermes_memory',
  ].join('\n')], {
    cwd: join(fx.home, 'workspace'),
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: fx.home,
      USER_HOME: fx.home,
      PI_CODING_AGENT_DIR: join(fx.home, '.pi/agent'),
      XDG_CACHE_HOME: join(fx.home, '.cache'),
      CODEFLARE_RUNTIME_ROOT: fx.runtime,
      SESSION_MODE: mode,
    },
  });
}

function succeeds(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function fails(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, 'unsafe startup must fail closed');
  assert.notEqual(`${result.stdout}${result.stderr}`.trim(), '', 'failure must be reported');
}

function config(fx) {
  return JSON.parse(readFileSync(join(fx.home, configFile), 'utf8'));
}

function normalizedMemoryDir(fx, value) {
  assert.equal(typeof value, 'string', 'memoryDir must be explicit');
  return resolve(join(fx.home, '.pi/agent'), value.replace(/^~(?=\/)/, fx.home));
}

function assertInside(parent, path) {
  const rel = relative(realpathSync(parent), path);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    `${path} must be inside ${parent}`);
}

// Do not follow links when inventorying durable files. Aliases are intentional;
// regular SQLite/sidecar/lock bytes in Vault are not.
function tree(path) {
  if (!existsSync(path) && !lstatExists(path)) return {};
  const entries = {};
  function visit(current, key) {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) entries[key] = { link: readlinkSync(current) };
    else if (info.isDirectory()) {
      entries[key] = { directory: true };
      for (const child of readdirSync(current).sort()) visit(join(current, child), key ? `${key}/${child}` : child);
    } else entries[key] = { bytes: readFileSync(current).toString('base64'), ino: info.ino };
  }
  visit(path, '');
  return entries;
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertNoDurableDatabase(fx) {
  const files = tree(join(fx.home, 'Vault'));
  const regular = Object.entries(files).filter(([, value]) => 'bytes' in value).map(([name]) => name);
  assert.deepEqual(regular.filter(name => /(?:\.db|\.sqlite)(?:-(?:wal|shm)|-journal)?$|(?:^|\/)\.consolidation-locks\//.test(name)), [],
    'database, recovery and coordination bytes must not reside in Vault');
}

function restoredMarkdown(fx) {
  const saved = new Map();
  for (const [i, file] of canonicalFiles.entries()) {
    const path = join(fx.home, file);
    // Intentionally retain CRLF, non-ASCII and trailing whitespace verbatim.
    put(path, `# Restored ${i}\r\nUser fact: café 工作区\r\n  retained whitespace  \r\n`);
    saved.set(path, { bytes: readFileSync(path), ino: statSync(path).ino });
  }
  return saved;
}

function assertSaved(saved) {
  for (const [path, before] of saved) {
    assert.deepEqual(readFileSync(path), before.bytes, `${path}: user bytes changed`);
    assert.equal(statSync(path).ino, before.ino, `${path}: user file replaced`);
  }
}

function assertLayout(fx) {
  const cache = join(fx.home, '.cache/pi-hermes-memory');
  assert.equal(normalizedMemoryDir(fx, config(fx).memoryDir), join(cache, 'global'));
  for (const file of canonicalFiles) {
    const path = join(fx.home, file);
    assert.ok(lstatSync(path).isFile(), `${file} must be a real canonical file`);
    assert.equal(realpathSync(path), path);
  }
  for (const name of ['USER.md', 'MEMORY.md', 'failures.md']) {
    const link = join(cache, 'global', name);
    assert.ok(lstatSync(link).isSymbolicLink(), `${name}: cache must point to Vault, not vice versa`);
    assert.equal(realpathSync(link), join(fx.home, 'Vault/Memory', name));
  }
  const projectLink = join(fx.home, '.pi/agent/hermes-project-memory');
  assert.ok(lstatSync(projectLink).isSymbolicLink());
  assert.equal(realpathSync(projectLink), join(fx.home, 'Vault/Memory/Projects'));
  assert.equal(realpathSync(join(projectLink, 'workspace/MEMORY.md')), join(fx.home, canonicalFiles[3]));
  const consolidation = join(fx.home, '.pi/agent/pi-hermes-memory/.consolidation-locks');
  assert.ok(lstatSync(consolidation).isSymbolicLink());
  assert.ok(statSync(consolidation).isDirectory());
  assertInside(cache, realpathSync(consolidation));
  assertNoDurableDatabase(fx);
}

function exerciseLocalState(fx) {
  const cache = join(fx.home, '.cache/pi-hermes-memory');
  const aliases = [
    join(fx.home, 'Vault/.pi-hermes-locks.sqlite'),
    join(fx.home, 'Vault/Memory/Projects/.pi-hermes-locks.sqlite'),
  ];
  const targets = [];
  for (const [i, alias] of aliases.entries()) {
    assert.ok(lstatSync(alias).isSymbolicLink(), 'mutation coordinator must be a link');
    // SQLite may not exist until upstream opens it. A real write through each
    // prepared alias must land in cache, including a previously dangling link.
    writeFileSync(alias, `coordinator-${i}`);
    const target = realpathSync(alias);
    assertInside(cache, target);
    targets.push(target);
    put(`${target}-wal`, `coordinator-${i}-wal`);
    put(`${target}-shm`, `coordinator-${i}-shm`);
  }
  assert.notEqual(targets[0], targets[1], 'global and project coordinators must be distinct');
  // Opaque sentinel bytes test storage placement/reuse, not SQLite semantics.
  // The separate upstream reconciliation suite owns actual database recovery.
  const db = join(cache, 'global/sessions.db');
  put(db, 'existing local search index');
  put(`${db}-wal`, 'uncheckpointed local facts');
  put(`${db}-shm`, 'local shared memory');
  put(`${db}-journal`, 'local recovery journal');
  put(join(fx.home, '.pi/agent/pi-hermes-memory/.consolidation-locks', 'active.lock'), 'active consolidation');
  assertNoDurableDatabase(fx);
  return tree(cache);
}

function assertDefaults(fx) {
  const written = config(fx);
  const defaults = {
    projectsMemoryDir: 'hermes-project-memory',
    memoryMode: 'policy-only',
    lazyInitialization: false,
    skillsEnabled: false,
    standingInstructionsEnabled: false,
    reviewEnabled: true,
    correctionDetection: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    consolidationChunking: true,
    autoConsolidate: false,
    memoryOverflowStrategy: 'reject',
    reviewRecentMessages: 20,
    flushRecentMessages: 20,
    sessionIndexExclude: ['*'],
  };
  for (const [key, expected] of Object.entries(defaults)) {
    assert.deepEqual(written[key], expected, `upstream configuration contract: ${key}`);
  }
}

function filterResolution() {
  const source = readFileSync(entrypoint, 'utf8');
  const start = source.indexOf('if [ "${SESSION_MODE:-default}" = "advanced" ]; then');
  const common = source.indexOf('RCLONE_FILTERS_COMMON=(', start);
  const end = source.indexOf('# ============================================================================\n# Recovery filter', common);
  if (start < 0 || common < start || end < common) throw new Error('Missing entrypoint filter resolution');
  return source.slice(start, end);
}

function transfer(fx, from, to) {
  const script = [
    'set -euo pipefail',
    'SYNC_MODE=full',
    'SYNC_POLICY_MODE=include',
    'SESSION_ID=hermes-fixture',
    'MANAGED_RESOURCE_POLICY=mutable',
    'MANAGED_RESOURCE_FILTER_FILE="$CODEFLARE_RUNTIME_ROOT/sync/managed.filter"',
    'RECOVERY_FILTER_FILE="$CODEFLARE_RUNTIME_ROOT/sync/recovery.filter"',
    ': > "$RECOVERY_FILTER_FILE"',
    filterResolution(),
    functionSource('prepare_managed_resource_filter'),
    functionSource('compose_rclone_filters'),
    'compose_rclone_filters',
    // A real local-to-local transfer uses production rules, no cloud credentials,
    // no copy-links and no test-added Hermes exclusion.
    'rclone copy --config /dev/null "${RCLONE_EFFECTIVE_FILTERS[@]}" "$1" "$2"',
  ].join('\n');
  return spawnSync('bash', ['-c', script, '_', from, to], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: fx.home, USER_HOME: fx.home, SESSION_MODE: 'advanced', CODEFLARE_RUNTIME_ROOT: fx.runtime },
  });
}

// Each named case is an observable portion of AC1, AC2, AC3 or AC4, not a
// claim that this startup-only suite verifies the entire multi-part criterion.
describe('Pi Hermes startup (actual entrypoint helper)', () => {
  it('REQ-MEM-035: AC3 restored facts and cache links exist before the foreground PTY is released', t => {
    const fx = fixture(t);
    const script = [
      'set -euo pipefail',
      functionSource('configure_pi_hermes_memory'),
      functionSource('complete_managed_curation_startup'),
      functionSource('run_managed_curation_startup'),
      'run_initial_r2_restore() { mkdir -p "$USER_HOME/Vault/Memory"; printf "Restored user preference" > "$USER_HOME/Vault/Memory/USER.md"; STEP1_RESULT=0; }',
      'run_post_restore_startup() { :; }',
      'prepare_managed_resource_filter() { :; }',
      'relay_managed_pi_extensions() { :; }',
      'configure_pi_packages_and_review_inventory() { :; }',
      'release_agent_pty_after_fast_start_updates() { test -L "$USER_HOME/.cache/pi-hermes-memory/global/USER.md"; test "$(cat "$USER_HOME/.cache/pi-hermes-memory/global/USER.md")" = "Restored user preference"; printf "released-after-memory-ready" > "$USER_HOME/release-result"; }',
      'RCLONE_CONFIG_RESULT=1',
      'CODEFLARE_SESSION_WORKSPACE=terminal',
      'run_managed_curation_startup',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000,
      env: { ...process.env, USER_HOME: fx.home, HOME: fx.home, SESSION_MODE: 'advanced',
        CODEFLARE_OPERATOR_SESSION: '', CODEFLARE_RUNTIME_ROOT: fx.runtime } });
    succeeds(result);
    assert.equal(readFileSync(join(fx.home, 'release-result'), 'utf8'), 'released-after-memory-ready');
    assert.equal(readFileSync(join(fx.home, 'Vault/Memory/USER.md'), 'utf8'), 'Restored user preference');
  });
  it('REQ-MEM-035: AC1/AC2/AC3 prepares advanced-only canonical layout and supported defaults from an empty home', t => {
    const fx = fixture(t);
    succeeds(run(fx, { explicitHome: false }));
    assertLayout(fx);
    assertDefaults(fx);
  });

  it('REQ-MEM-035: AC3 preserves restored Markdown bytes and reuses warm database, sidecars and locks', t => {
    const fx = fixture(t);
    const saved = restoredMarkdown(fx);
    succeeds(run(fx));
    assertLayout(fx);
    const warm = exerciseLocalState(fx);
    const settingsBytes = readFileSync(join(fx.home, configFile));
    succeeds(run(fx));
    assertSaved(saved);
    assertLayout(fx);
    assert.deepEqual(tree(join(fx.home, '.cache/pi-hermes-memory')), warm, 'warm startup must reuse existing local state');
    assert.deepEqual(readFileSync(join(fx.home, configFile)), settingsBytes, 'repeat startup must not rewrite settings');
  });

  it('REQ-MEM-035: AC1/AC3 preserves supported provider overrides, unrelated config fields and Pi settings', t => {
    const fx = fixture(t);
    const preferences = {
      llmModelOverride: 'anthropic/claude-haiku-4-5',
      llmThinkingOverride: 'off',
      nudgeInterval: 12,
      nudgeToolCalls: 18,
      memoryPolicyStyle: 'compact',
      memoryOverflowStrategy: 'reject',
      autoConsolidate: false,
      futureUserOption: { enabled: false, labels: ['keep', '用户'] },
    };
    put(join(fx.home, configFile), JSON.stringify({
      ...preferences,
      // Only managed safety/layout fields are replaced on legacy config.
      memoryDir: join(fx.home, 'Vault/Memory'),
      projectsMemoryDir: 'projects-memory',
      memoryMode: 'legacy-inject',
      lazyInitialization: true,
      skillsEnabled: true,
      standingInstructionsEnabled: true,
      reviewRecentMessages: 0,
      flushRecentMessages: 0,
      sessionIndexExclude: [],
    }));
    const settings = '{\n  "theme": "personal", "packages": ["npm:personal-package"], "future": false\n}\n';
    put(join(fx.home, '.pi/agent/settings.json'), settings);
    succeeds(run(fx));
    assertDefaults(fx);
    const written = config(fx);
    for (const [key, value] of Object.entries(preferences)) assert.deepEqual(written[key], value, key);
    assert.equal(readFileSync(join(fx.home, '.pi/agent/settings.json'), 'utf8'), settings);
  });

  for (const enabled of [false, true]) {
    it(`REQ-MEM-035: AC3 preserves explicit consolidation chunking (${enabled}) across preparation`, t => {
      const fx = fixture(t);
      put(join(fx.home, configFile), JSON.stringify({ consolidationChunking: enabled }));
      succeeds(run(fx));
      assert.equal(config(fx).consolidationChunking, enabled);
      const prepared = readFileSync(join(fx.home, configFile));
      succeeds(run(fx));
      assert.deepEqual(readFileSync(join(fx.home, configFile)), prepared);
    });
  }

  it('REQ-MEM-035: explicit capture and flush opt-outs survive container preparation', t => {
    const fx = fixture(t);
    const optOut = { reviewEnabled: false, correctionDetection: false, flushOnCompact: false, flushOnShutdown: false };
    put(join(fx.home, configFile), JSON.stringify(optOut));
    succeeds(run(fx));
    for (const [key, value] of Object.entries(optOut)) assert.equal(config(fx)[key], value);
    assertLayout(fx);
  });

  it('REQ-MEM-035: AC1 default mode neither initializes personal memory nor changes existing user state', t => {
    const fx = fixture(t);
    succeeds(run(fx, { mode: 'default' }));
    for (const path of ['Vault', '.cache/pi-hermes-memory', '.pi']) assert.equal(lstatExists(join(fx.home, path)), false, path);
    restoredMarkdown(fx);
    put(join(fx.home, configFile), '{"personal":true}\n');
    put(join(fx.home, '.pi/agent/hermes-runtime/live.db-wal'), 'live writer');
    const before = tree(fx.home);
    succeeds(run(fx, { mode: 'default' }));
    assert.deepEqual(tree(fx.home), before);
  });

  it('REQ-MEM-035: AC3 ordinary startup does not migrate, unlink or delete legacy hermes-runtime with live writers', t => {
    const fx = fixture(t);
    for (const name of ['sessions.db', 'sessions.db-wal', 'sessions.db-shm', '.pi-hermes-locks.sqlite']) {
      put(join(fx.home, '.pi/agent/hermes-runtime', name), `legacy live ${name}`);
    }
    const legacy = join(fx.home, '.pi/agent/hermes-runtime');
    const before = tree(legacy);
    succeeds(run(fx));
    succeeds(run(fx));
    assert.deepEqual(tree(legacy), before, 'migration requires separate explicit approval');
    assertLayout(fx);
  });

  for (const value of ['{broken json\n', 'null\n', '[]\n', '"not a config object"\n']) {
    it(`REQ-MEM-035: AC3 rejects malformed or non-object config without overwriting it (${value.trim()})`, t => {
      const fx = fixture(t);
      const saved = restoredMarkdown(fx);
      put(join(fx.home, configFile), value);
      fails(run(fx));
      assert.equal(readFileSync(join(fx.home, configFile), 'utf8'), value);
      assertSaved(saved);
      assertNoDurableDatabase(fx);
    });
  }

  const conflicts = [
    ['.pi/agent/hermes-project-memory', 'directory'],
    ['.cache/pi-hermes-memory/global/USER.md', 'file'],
    ['Vault/.pi-hermes-locks.sqlite', 'file'],
    ['Vault/Memory/Projects/.pi-hermes-locks.sqlite', 'file'],
    ['.pi/agent/pi-hermes-memory/.consolidation-locks', 'directory'],
    ['Vault/Memory/USER.md', 'directory'],
  ];
  for (const [path, kind] of conflicts) {
    it(`REQ-MEM-035: AC3 refuses conflicting real ${path} without overwriting user bytes`, t => {
      const fx = fixture(t);
      const target = join(fx.home, path);
      put(kind === 'directory' ? join(target, 'user-owned.txt') : target, 'user-owned, not disposable\n');
      const before = tree(target);
      fails(run(fx));
      assert.deepEqual(tree(target), before);
    });
  }

  for (const path of [
    'Vault', 'Vault/Memory', 'Vault/Memory/Projects', 'Vault/Memory/Projects/workspace',
    '.cache', '.cache/pi-hermes-memory', '.cache/pi-hermes-memory/global',
    '.pi', '.pi/agent', '.pi/agent/pi-hermes-memory',
  ]) {
    it(`REQ-MEM-035: AC3 rejects escaping ancestor ${path} before writing outside home`, t => {
      const fx = fixture(t);
      const outside = join(fx.root, 'outside');
      put(join(outside, 'user-owned.txt'), 'outside user data\n');
      const alias = join(fx.home, path);
      mkdirSync(dirname(alias), { recursive: true });
      symlinkSync(outside, alias, 'dir');
      const before = tree(outside);
      fails(run(fx));
      assert.deepEqual(tree(outside), before, 'no writes through an unsafe ancestor');
      assert.ok(lstatSync(alias).isSymbolicLink());
      assert.equal(realpathSync(alias), outside, 'unsafe ancestor must not be replaced');
    });
  }

  for (const path of [
    'Vault/Memory/USER.md', '.cache/pi-hermes-memory/global/MEMORY.md',
    '.cache/pi-hermes-memory/global/sessions.db-wal', '.cache/pi-hermes-memory/global-locks.sqlite-shm',
    '.pi/agent/hermes-project-memory', 'Vault/.pi-hermes-locks.sqlite',
    'Vault/Memory/Projects/.pi-hermes-locks.sqlite',
    '.pi/agent/pi-hermes-memory/.consolidation-locks', configFile,
  ]) {
    it(`REQ-MEM-035: AC3 refuses unexpected symlink ${path} and preserves its target`, t => {
      const fx = fixture(t);
      const target = join(fx.home, 'personal', 'not-hermes');
      const directory = path === '.pi/agent/hermes-project-memory'
        || path === '.pi/agent/pi-hermes-memory/.consolidation-locks';
      put(directory ? join(target, 'user-owned.txt') : target,
        path === configFile ? '{"futureUserOption":true}\n' : 'unrelated user bytes\n');
      const alias = join(fx.home, path);
      mkdirSync(dirname(alias), { recursive: true });
      symlinkSync(target, alias, directory ? 'dir' : 'file');
      const before = tree(target);
      fails(run(fx));
      assert.deepEqual(tree(target), before);
      assert.ok(lstatSync(alias).isSymbolicLink());
      assert.equal(realpathSync(alias), target);
    });
  }

  it('REQ-MEM-035: AC2 existing rclone rules transfer canonical Markdown but no cache, sidecars, locks or alias copies', t => {
    const fx = fixture(t);
    const saved = restoredMarkdown(fx);
    succeeds(run(fx));
    exerciseLocalState(fx);
    const remote = join(fx.root, 'remote');
    const restored = join(fx.root, 'restored');
    succeeds(transfer(fx, fx.home, remote));
    const uploaded = tree(remote);
    for (const [path, before] of saved) {
      const rel = relative(fx.home, path);
      assert.deepEqual(readFileSync(join(remote, rel)), before.bytes, `${rel} must be synchronized`);
    }
    const names = Object.keys(uploaded);
    assert.deepEqual(names.filter(name => /(?:^|\/)\.cache(?:\/|$)|(?:\.db|\.sqlite)(?:-|$)|\.consolidation-locks|hermes-project-memory/.test(name)), [],
      'remote inventory must not contain databases, recovery/coordination state or copied links');
    assert.deepEqual(names.filter(name => canonicalFiles.some(file => name.endsWith(file.split('/').at(-1)))).sort(),
      [...canonicalFiles].sort(), 'only the canonical Markdown copies may be uploaded');
    succeeds(transfer(fx, remote, restored));
    for (const file of canonicalFiles) assert.deepEqual(readFileSync(join(restored, file)), readFileSync(join(fx.home, file)));
    assert.equal(lstatExists(join(restored, '.cache/pi-hermes-memory')), false);
  });
});
