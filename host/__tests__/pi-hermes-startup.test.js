// REQ-MEM-035 AC1–4 (startup subset). Execute the real entrypoint helper;
// package loading, deferred SQLite reconciliation and request context belong to
// their integration suites. In particular, this does not claim REQ-MEM-036.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = resolve(dirname(fileURLToPath(import.meta.url)), '../../entrypoint.sh');
const canonicalFiles = [
  'Vault/Memory/USER.md',
  'Vault/Memory/MEMORY.md',
  'Vault/Memory/failures.md',
  'Vault/Memory/Projects/workspace/MEMORY.md',
];
const sessionId = 'hermesfixture';
const sessionRoot = `Vault/Memory/Sessions/${sessionId}`;
const oldWorkingRoot = '.cache/pi-hermes-memory/working';
const adapterPath = '.pi/agent/extensions/hermes-memory-runtime.ts';
const imageAdapterDir = resolve(dirname(entrypoint), 'preseed/agents/pi/extensions');
const installV197 = fx => put(join(fx.home, adapterPath), readFileSync(new URL('../__fixtures__/pi-hermes-curation-v197.ts.txt', import.meta.url)));
const checkpointFile = id => `Vault/Memory/Sessions/${id}/checkpoint.json`;
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
  put(join(home, adapterPath), readFileSync(join(imageAdapterDir, 'hermes-memory-runtime.ts')));
  return { root, home, runtime };
}

function run(fx, { mode = 'advanced', explicitHome = true, id = sessionId, checkpoint = false, remote = false,
  persistence = 'new', generation = '1', faultHooks } = {}) {
  return spawnSync('bash', ['-c', [
    'set -euo pipefail',
    functionSource('configure_pi_hermes_memory'),
    checkpoint ? 'configure_pi_hermes_memory "$USER_HOME" checkpoint' : explicitHome ? 'configure_pi_hermes_memory "$USER_HOME"' : 'configure_pi_hermes_memory',
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
      SESSION_MODE: mode, SESSION_ID: id, REMOTE_CURATION_ACTIVE: String(remote),
      PI_WARM_EXTENSIONS_DIR: imageAdapterDir, CODEFLARE_HERMES_PERSISTENCE: persistence,
      CODEFLARE_HERMES_GENERATION: generation, ...(faultHooks ? { PYTHONPATH: faultHooks } : {}),
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
  const local = join(fx.home, sessionRoot);
  assert.equal(normalizedMemoryDir(fx, config(fx).memoryDir), join(local, 'global'));
  for (const path of canonicalFiles) {
    const master = join(fx.home, path);
    if (lstatExists(master)) assert.ok(lstatSync(master).isFile());
  }
  for (const name of ['USER.md', 'MEMORY.md', 'failures.md']) {
    assert.ok(lstatSync(join(local, 'global', name)).isFile());
    const master = join(fx.home, 'Vault/Memory', name);
    if (lstatExists(master)) assert.notEqual(statSync(join(local, 'global', name)).ino, statSync(master).ino);
  }
  const projects = join(fx.home, '.pi/agent/hermes-project-memory');
  assert.equal(realpathSync(projects), join(local, 'Projects'));
  assert.ok(lstatSync(join(local, 'Projects/workspace/MEMORY.md')).isFile());
}

function exerciseLocalState(fx) {
  const local = join(fx.home, sessionRoot);
  for (const file of ['.pi-hermes-locks.sqlite', 'Projects/.pi-hermes-locks.sqlite',
    'global/sessions.db', 'global/sessions.db-wal', 'global/sessions.db-shm', 'global/sessions.db-journal']) {
    put(join(local, file), 'local sentinel');
  }
  return tree(local);
}

function assertDefaults(fx) {
  const written = config(fx);
  const defaults = {
    projectsMemoryDir: 'hermes-project-memory',
    memoryMode: 'policy-only',
    lazyInitialization: true,
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
  it('REQ-MEM-035: a new image preserves the installed legacy signed adapter and activates isolation after seed upgrade', t => {
    const fx = fixture(t);
    const saved = restoredMarkdown(fx);
    const adapter = join(fx.home, '.pi/agent/extensions/hermes-memory-runtime.ts');
    const legacy = readFileSync(new URL('../__fixtures__/pi-hermes-curation-legacy.ts.txt', import.meta.url));
    put(adapter, legacy);
    succeeds(run(fx, { remote: true, persistence: 'legacy' }));
    const global = join(fx.home, '.cache/pi-hermes-memory/global');
    assert.equal(config(fx).memoryDir, global);
    assert.equal(realpathSync(join(global, 'USER.md')), join(fx.home, canonicalFiles[0]));
    assert.equal(realpathSync(join(fx.home, '.pi/agent/hermes-project-memory')), join(fx.home, 'Vault/Memory/Projects'));
    assert.deepEqual(readFileSync(adapter), legacy, 'the image must not rewrite the signed adapter');
    assert.equal(lstatExists(join(fx.home, oldWorkingRoot)), false);
    const updated = readFileSync(new URL('../../preseed/agents/pi/extensions/hermes-memory-runtime.ts', import.meta.url));
    put(adapter, updated);
    succeeds(run(fx, { remote: true }));
    const session = join(fx.home, 'Vault/Memory/Sessions', sessionId);
    const current = normalizedMemoryDir(fx, config(fx).memoryDir);
    assert.equal(current, join(session, 'global'));
    assert.equal(realpathSync(join(fx.home, '.pi/agent/hermes-project-memory')), join(session, 'Projects'));
    assert.deepEqual(readFileSync(join(current, 'USER.md')), saved.get(join(fx.home, canonicalFiles[0])).bytes);
    assert.deepEqual(readFileSync(adapter), updated, 'the signed update must also remain untouched');
    assertSaved(saved);
  });

  it('REQ-MEM-041: uses real per-session Markdown and does not import or rewrite legacy checkpoints', t => {
    const fx = fixture(t);
    const masters = restoredMarkdown(fx);
    const legacyPath = join(fx.home, checkpointFile(sessionId));
    // The prior format is opaque to direct-layout startup, even if invalid.
    const legacyBytes = Buffer.from('{"current":{"MEMORY.md":"checkpoint-only fact"}}\n');
    put(legacyPath, legacyBytes);
    succeeds(run(fx));
    const store = join(fx.home, 'Vault/Memory/Sessions', sessionId);
    const global = normalizedMemoryDir(fx, config(fx).memoryDir);
    const project = join(realpathSync(join(fx.home, '.pi/agent', config(fx).projectsMemoryDir)), 'workspace/MEMORY.md');
    for (const [master, local] of [
      ...['USER.md', 'MEMORY.md', 'failures.md'].map(name => [name, join(global, name)]),
      ['Projects/workspace/MEMORY.md', project],
    ]) {
      assert.ok(!relative(store, local).startsWith('..'), local);
      assert.ok(lstatSync(local).isFile(), `${local} must be real Markdown, not a link to a master`);
      assert.deepEqual(readFileSync(local), readFileSync(join(fx.home, 'Vault/Memory', master)));
    }
    const memory = join(global, 'MEMORY.md');
    writeFileSync(memory, 'Only this session remembers.\r\n');
    succeeds(run(fx));
    assert.equal(readFileSync(memory, 'utf8'), 'Only this session remembers.\r\n');
    assert.deepEqual(readFileSync(legacyPath), legacyBytes);
    const privateCopy = fixture(t);
    restoredMarkdown(privateCopy);
    succeeds(run(privateCopy, { id: 'otherfixture' }));
    const otherGlobal = normalizedMemoryDir(privateCopy, config(privateCopy).memoryDir);
    assert.notEqual(readFileSync(join(otherGlobal, 'MEMORY.md'), 'utf8'), readFileSync(memory, 'utf8'));
    assertSaved(masters);
  });

  it('REQ-MEM-041 AC1: a new user without Vault masters gets an empty usable session store', t => {
    const fx = fixture(t);
    succeeds(run(fx));
    const store = join(fx.home, 'Vault/Memory/Sessions', sessionId);
    const global = normalizedMemoryDir(fx, config(fx).memoryDir);
    const projects = realpathSync(join(fx.home, '.pi/agent', config(fx).projectsMemoryDir));
    assert.equal(global, join(store, 'global'));
    assert.equal(projects, join(store, 'Projects'));
    for (const path of [join(global, 'USER.md'), join(global, 'MEMORY.md'), join(global, 'failures.md'),
      join(projects, 'workspace/MEMORY.md')]) {
      assert.deepEqual(readFileSync(path), Buffer.alloc(0));
    }
    for (const master of canonicalFiles) assert.equal(existsSync(join(fx.home, master)), false, master);
    writeFileSync(join(global, 'MEMORY.md'), 'First session fact.\n');
    succeeds(run(fx));
    assert.equal(readFileSync(join(global, 'MEMORY.md'), 'utf8'), 'First session fact.\n');
  });

  it('REQ-MEM-041 AC3: refuses to reseed a partially restored initialized store', t => {
    const original = fixture(t), resumed = fixture(t);
    restoredMarkdown(original);
    const masters = restoredMarkdown(resumed);
    succeeds(run(original));
    const relativeStore = `Vault/Memory/Sessions/${sessionId}`;
    const store = join(resumed.home, relativeStore);
    const originalStore = join(original.home, relativeStore);
    const ownFile = 'global/MEMORY.md';
    assert.equal(normalizedMemoryDir(original, config(original).memoryDir), join(originalStore, 'global'));
    writeFileSync(join(originalStore, ownFile), 'Keep this existing session edit.\n');
    mkdirSync(dirname(store), { recursive: true });
    cpSync(originalStore, store, { recursive: true });
    rmSync(join(store, 'global/USER.md'));
    const before = tree(store);
    fails(run(resumed, { persistence: 'existing' }));
    assert.deepEqual(tree(store), before, 'a partial restore must not replace the surviving session files');
    assert.equal(existsSync(join(resumed.home, configFile)), false);
    assertSaved(masters);
  });

  it('REQ-MEM-041 AC3: a timed-out restore releases the terminal without seeding Hermes', t => {
    const fx = fixture(t);
    const masters = restoredMarkdown(fx);
    const script = [
      'set -euo pipefail',
      ...['initial_sync_from_r2', 'run_initial_r2_restore', 'configure_pi_hermes_memory',
        'complete_managed_curation_startup', 'run_managed_curation_startup'].map(functionSource),
      'compose_rclone_filters() { RCLONE_EFFECTIVE_FILTERS=(); }',
      'timeout() { return 124; }',
      'cleanup_rclone_conflicts() { return "$3"; }',
      'validate_coding_agent_selection() { :; }',
      'lay_down_agent_seed_preseed() { :; }',
      'update_sync_status() { :; }',
      'run_post_restore_startup() { RCLONE_CONFIG_RESULT=1; }',
      'restore_startup_repositories() { :; }',
      'prepare_managed_resource_filter() { :; }',
      'relay_managed_pi_extensions() { :; }',
      'configure_pi_packages_and_review_inventory() { :; }',
      'release_agent_pty_after_fast_start_updates() { printf ready > "$USER_HOME/release-result"; }',
      'RCLONE_CONFIG_RESULT=0 RCLONE_CONFIG=/dev/null R2_BUCKET_NAME=fixture SYNC_ERROR="Restore incomplete"',
      'run_managed_curation_startup',
    ].join('\n');
    succeeds(spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20_000, env: {
      ...process.env, HOME: fx.home, USER_HOME: fx.home, USER_WORKSPACE: join(fx.home, 'workspace'),
      CODEFLARE_RUNTIME_ROOT: fx.runtime, SESSION_MODE: 'advanced', SESSION_ID: sessionId,
      CODEFLARE_SESSION_WORKSPACE: 'terminal', CODEFLARE_OPERATOR_SESSION: '', CODEFLARE_POLICY_STATUS_FILE: '',
      CODEFLARE_HERMES_PERSISTENCE: 'new', PI_WARM_EXTENSIONS_DIR: imageAdapterDir,
      REMOTE_CURATION_ACTIVE: 'false', ENTERPRISE_MODE: '',
    } }));
    assert.equal(readFileSync(join(fx.home, 'release-result'), 'utf8'), 'ready');
    assert.equal(existsSync(join(fx.home, configFile)), false, 'incomplete restore must not authorize memory configuration');
    assert.deepEqual(tree(join(fx.home, 'Vault/Memory/Sessions')), {});
    assertSaved(masters);
  });

  it('REQ-MEM-041 AC5: v197 retains its own checkpoint behavior without changing signed bytes', t => {
    const fx = fixture(t), restored = fixture(t);
    const saved = restoredMarkdown(fx);
    installV197(fx);
    installV197(restored);
    const adapter = join(fx.home, adapterPath);
    const signed = readFileSync(adapter);
    const legacy = { remote: true, persistence: 'legacy' };
    succeeds(run(fx, legacy));
    const worker = target => join(target.home, oldWorkingRoot, 'global/USER.md');
    const original = readFileSync(worker(fx), 'utf8');
    put(worker(fx), 'Updated v197 memory');
    succeeds(run(fx, { ...legacy, checkpoint: true }));
    const file = checkpointFile(sessionId);
    const checkpoint = readFileSync(join(fx.home, file));
    assert.equal(JSON.parse(checkpoint).base['USER.md'], original);
    put(join(restored.home, file), checkpoint);
    succeeds(run(restored, legacy));
    assert.equal(readFileSync(worker(restored), 'utf8'), 'Updated v197 memory');
    put(worker(fx), 'A change whose directory flush fails');
    const faultHooks = join(fx.root, 'fault-hooks');
    put(join(faultHooks, 'sitecustomize.py'), `import os\noriginal = os.fsync\ndef fail_once(fd):\n    if os.readlink('/proc/self/fd/' + str(fd)).endswith('/Vault/Memory/Sessions/${sessionId}'):\n        os.fsync = original\n        raise OSError('fixture directory flush failure')\n    original(fd)\nos.fsync = fail_once\n`);
    fails(run(fx, { ...legacy, checkpoint: true, faultHooks }));
    assert.deepEqual(readFileSync(join(fx.home, file)), checkpoint, 'the predecessor survives a late flush failure');
    rmSync(join(fx.home, oldWorkingRoot, 'global/failures.md'));
    fails(run(fx, { ...legacy, checkpoint: true }));
    assert.deepEqual(readFileSync(join(fx.home, file)), checkpoint);
    assert.deepEqual(readFileSync(adapter), signed);
    assertSaved(saved);
  });

  it('REQ-MEM-041 AC6: direct admission or a local direct marker prevents fallback to signed legacy adapters', t => {
    for (const name of ['pi-hermes-curation-legacy.ts.txt', 'pi-hermes-curation-v197.ts.txt']) {
      const fx = fixture(t);
      const saved = restoredMarkdown(fx);
      const signed = readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url));
      const adapter = join(fx.home, adapterPath);
      put(adapter, signed);
      for (const persistence of ['', 'deferred', 'new', 'existing']) {
        fails(run(fx, { remote: true, persistence }));
        assert.equal(lstatExists(join(fx.home, configFile)), false);
      }
      put(adapter, readFileSync(join(imageAdapterDir, 'hermes-memory-runtime.ts')));
      succeeds(run(fx));
      put(adapter, signed);
      const store = join(fx.home, sessionRoot);
      const before = tree(store);
      fails(run(fx, { remote: true, persistence: 'legacy' }));
      assert.equal(config(fx).memoryDir, join(store, 'global'));
      assert.deepEqual(tree(store), before);
      assert.deepEqual(readFileSync(adapter), signed);
      assertSaved(saved);
    }
  });

  it('REQ-MEM-041 AC6: a replacement without a checkpoint never falls back to master writes', t => {
    const fx = fixture(t);
    const masters = restoredMarkdown(fx);
    const signed = readFileSync(new URL('../__fixtures__/pi-hermes-curation-legacy.ts.txt', import.meta.url));
    put(join(fx.home, adapterPath), signed);
    fails(run(fx, { remote: true, persistence: 'legacy', generation: '2' }));
    assert.equal(existsSync(join(fx.home, configFile)), false);
    assertSaved(masters);
  });

  it('REQ-MEM-041 AC7: new admission on a warm home seeds current masters, not evicted memory', t => {
    const fx = fixture(t);
    restoredMarkdown(fx);
    succeeds(run(fx));
    const global = join(fx.home, sessionRoot, 'global');
    put(join(global, 'MEMORY.md'), 'Evicted memory');
    put(join(global, 'sessions.db'), 'Evicted index');
    put(join(fx.home, canonicalFiles[1]), 'Current master');
    put(join(fx.home, checkpointFile(sessionId)), 'Untouched legacy checkpoint');
    succeeds(run(fx, { generation: '2' }));
    assert.equal(readFileSync(join(global, 'MEMORY.md'), 'utf8'), 'Current master');
    assert.equal(existsSync(join(global, 'sessions.db')), false);
    assert.equal(readFileSync(join(fx.home, checkpointFile(sessionId)), 'utf8'), 'Untouched legacy checkpoint');
    assert.equal(readFileSync(join(fx.home, canonicalFiles[1]), 'utf8'), 'Current master');
  });

  it('REQ-MEM-041 AC7: interrupted warm retirement resumes without publishing old bytes', t => {
    const fx = fixture(t);
    restoredMarkdown(fx);
    succeeds(run(fx));
    const global = join(fx.home, sessionRoot, 'global');
    put(join(global, 'MEMORY.md'), 'Evicted fact');
    put(join(fx.home, canonicalFiles[1]), 'Current master');
    const checkpoint = join(fx.home, checkpointFile(sessionId));
    put(checkpoint, 'Untouched checkpoint');
    const hooks = join(fx.root, 'retirement-fault');
    put(join(hooks, 'sitecustomize.py'), `import os\nrename = os.rename\ndef interrupt(src, dst, *args, **kwargs):\n    rename(src, dst, *args, **kwargs)\n    if os.fsdecode(src).endswith('/${sessionRoot}/global'):\n        os._exit(91)\nos.rename = interrupt\n`);
    assert.equal(run(fx, { generation: '2', faultHooks: hooks }).status, 91);
    assert.equal(existsSync(global), false);
    assert.equal(readFileSync(join(fx.home, sessionRoot, 'session-id'), 'utf8'), `${sessionId}\n`);
    succeeds(run(fx, { generation: '2' }));
    assert.equal(readFileSync(join(global, 'MEMORY.md'), 'utf8'), 'Current master');
    assert.equal(readFileSync(checkpoint, 'utf8'), 'Untouched checkpoint');
  });

  it('REQ-MEM-043 AC4: committed checkpoint survives staging cleanup failure', t => {
    const fx = fixture(t);
    installV197(fx);
    const legacy = { remote: true, persistence: 'legacy' };
    succeeds(run(fx, legacy));
    const memory = join(fx.home, oldWorkingRoot, 'global/USER.md');
    const checkpoint = join(fx.home, checkpointFile(sessionId));
    put(memory, 'Predecessor');
    succeeds(run(fx, { ...legacy, checkpoint: true }));
    const hooks = join(fx.root, 'cleanup-fault');
    put(join(hooks, 'sitecustomize.py'), `import os\nunlink = os.unlink\ndef refuse_backup_cleanup(path, *args, **kwargs):\n    if os.fsdecode(path).endswith('.prior'):\n        raise OSError('fixture cleanup failure')\n    return unlink(path, *args, **kwargs)\nos.unlink = refuse_backup_cleanup\n`);
    put(memory, 'Committed successor');
    const result = run(fx, { ...legacy, checkpoint: true, faultHooks: hooks });
    succeeds(result);
    assert.match(result.stderr, /checkpoint staging cleanup incomplete/);
    assert.equal(JSON.parse(readFileSync(checkpoint, 'utf8')).current['USER.md'], 'Committed successor');
  });

  it('REQ-MEM-043 AC4: failed checkpoint rollback retains the predecessor and is reported separately', t => {
    const fx = fixture(t);
    installV197(fx);
    const legacy = { remote: true, persistence: 'legacy' };
    succeeds(run(fx, legacy));
    const memory = join(fx.home, oldWorkingRoot, 'global/USER.md');
    const checkpoint = join(fx.home, checkpointFile(sessionId));
    put(memory, 'Predecessor');
    succeeds(run(fx, { ...legacy, checkpoint: true }));
    const predecessor = readFileSync(checkpoint);
    const hooks = join(fx.root, 'rollback-fault');
    put(join(hooks, 'sitecustomize.py'), `import os\nfsync, replace = os.fsync, os.replace\ndef fail_flush(fd):\n    if os.readlink('/proc/self/fd/' + str(fd)).endswith('/${sessionRoot}'):\n        raise OSError('fixture directory flush failure')\n    fsync(fd)\ndef fail_rollback(src, dst):\n    if os.fsdecode(src).endswith('.prior'):\n        raise OSError('fixture rollback failure')\n    replace(src, dst)\nos.fsync, os.replace = fail_flush, fail_rollback\n`);
    put(memory, 'Unconfirmed successor');
    const result = run(fx, { ...legacy, checkpoint: true, faultHooks: hooks });
    fails(result);
    assert.match(result.stderr, /checkpoint rollback incomplete/);
    const cache = join(fx.home, '.cache/pi-hermes-memory');
    const retained = readdirSync(cache).filter(name => name.endsWith('.prior'));
    assert.equal(retained.length, 1);
    assert.deepEqual(readFileSync(join(cache, retained[0])), predecessor);
  });

  it('REQ-MEM-035: AC3 restored facts and cache links exist before the foreground PTY is released', t => {
    const fx = fixture(t);
    const script = [
      'set -euo pipefail',
      functionSource('configure_pi_hermes_memory'),
      functionSource('prepare_pi_hermes_persistence'),
      functionSource('complete_managed_curation_startup'),
      functionSource('run_managed_curation_startup'),
      'run_initial_r2_restore() { mkdir -p "$USER_HOME/Vault/Memory"; printf "Restored user preference" > "$USER_HOME/Vault/Memory/USER.md"; STEP1_RESULT=0; }',
      'run_post_restore_startup() { :; }',
      'CODEFLARE_POLICY_STATUS_FILE=',
      'restore_startup_repositories() { :; }',
      'prepare_managed_resource_filter() { :; }',
      'relay_managed_pi_extensions() { :; }',
      'configure_pi_packages_and_review_inventory() { :; }',
      'release_agent_pty_after_fast_start_updates() { test -f "$USER_HOME/Vault/Memory/Sessions/$SESSION_ID/global/USER.md"; test "$(cat "$USER_HOME/Vault/Memory/Sessions/$SESSION_ID/global/USER.md")" = "Restored user preference"; printf "released-after-memory-ready" > "$USER_HOME/release-result"; }',
      'RCLONE_CONFIG_RESULT=1',
      'CODEFLARE_SESSION_WORKSPACE=terminal',
      'run_managed_curation_startup',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000,
      env: { ...process.env, USER_HOME: fx.home, HOME: fx.home, SESSION_MODE: 'advanced', SESSION_ID: sessionId,
        CODEFLARE_OPERATOR_SESSION: '', CODEFLARE_RUNTIME_ROOT: fx.runtime,
        CODEFLARE_HERMES_PERSISTENCE: 'new', PI_WARM_EXTENSIONS_DIR: imageAdapterDir } });
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
    assert.deepEqual(tree(join(fx.home, sessionRoot)), warm, 'warm startup must reuse existing local state');
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
      lazyInitialization: false,
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
    for (const path of ['Vault', '.cache/pi-hermes-memory', configFile]) assert.equal(lstatExists(join(fx.home, path)), false, path);
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
        });
  }

  const conflicts = [
    ['.pi/agent/hermes-project-memory', 'directory'],
    [`${sessionRoot}/global/USER.md`, 'directory'],
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
    '.cache', '.cache/pi-hermes-memory', `${sessionRoot}/global`,
    '.cache/pi-hermes-memory/consolidation-locks', '.pi', '.pi/agent',
  ]) {
    it(`REQ-MEM-035: AC3 rejects escaping ancestor ${path} before writing outside home`, t => {
      const fx = fixture(t);
      const outside = join(fx.root, 'outside');
      put(join(outside, 'user-owned.txt'), 'outside user data\n');
      const alias = join(fx.home, path);
      mkdirSync(dirname(alias), { recursive: true });
      if (path === '.pi' || path === '.pi/agent') rmSync(alias, { recursive: true });
      symlinkSync(outside, alias, 'dir');
      const before = tree(outside);
      fails(run(fx));
      assert.deepEqual(tree(outside), before, 'no writes through an unsafe ancestor');
      assert.ok(lstatSync(alias).isSymbolicLink());
      assert.equal(realpathSync(alias), outside, 'unsafe ancestor must not be replaced');
    });
  }

  for (const path of [
    'Vault/Memory/USER.md', `${sessionRoot}/global/MEMORY.md`,
    `${sessionRoot}/global/sessions.db-wal`, `${sessionRoot}/.pi-hermes-locks.sqlite-shm`,
    '.pi/agent/hermes-project-memory',
    '.cache/pi-hermes-memory/consolidation-locks', configFile,
  ]) {
    it(`REQ-MEM-035: AC3 refuses unexpected symlink ${path} and preserves its target`, t => {
      const fx = fixture(t);
      const target = join(fx.home, 'personal', 'not-hermes');
      const directory = path === '.pi/agent/hermes-project-memory'
        || path === '.cache/pi-hermes-memory/consolidation-locks';
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
      [...canonicalFiles].sort(), 'ordinary sync may upload master Markdown, not the native store');
    succeeds(transfer(fx, remote, restored));
    for (const file of canonicalFiles) assert.deepEqual(readFileSync(join(restored, file)), readFileSync(join(fx.home, file)));
    assert.equal(lstatExists(join(restored, '.cache/pi-hermes-memory')), false);
  });
});
