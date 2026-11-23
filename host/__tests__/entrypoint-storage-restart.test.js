import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = readFileSync(join(root, 'entrypoint.sh'), 'utf8');
const exec = promisify(execFile);

// Same heredoc-aware extraction as the existing managed-curation fixture.
function shellFunction(name) {
  const lines = source.split('\n');
  const start = lines.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} missing`);
  let heredoc;
  for (let i = start + 1; i < lines.length; i++) {
    if (heredoc) {
      if (lines[i].replace(/^\t+/, '') === heredoc) heredoc = undefined;
      continue;
    }
    const marker = lines[i].match(/<<-?\s*['"]?([A-Za-z_]\w*)['"]?/);
    if (marker) heredoc = marker[1];
    else if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`${name} terminator missing`);
}

const filterStart = source.indexOf('if [ "${SESSION_MODE:-default}" = "advanced" ]; then');
const filterEnd = source.indexOf('# ============================================================================\n# Recovery filter', filterStart);
assert.ok(filterStart >= 0 && filterEnd > filterStart);
const filters = source.slice(filterStart, filterEnd);
const policy = source.slice(source.indexOf('prepare_managed_resource_filter() {'), source.indexOf('# Step 1: One-way sync FROM R2 TO local'));
const bootStart = source.indexOf('# Ensure hook files in ~/.claude/hooks/ are executable.');
const bootEnd = source.indexOf('# Enable plugins', bootStart);
assert.ok(bootStart >= 0 && bootEnd > bootStart);
const bootRepair = source.slice(bootStart, bootEnd);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'storage-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, 'home');
  const runtime = join(directory, 'runtime');
  const put = (base, path, bytes) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), bytes);
  };
  for (const path of [home, join(runtime, 'sync/rclone')]) mkdirSync(path, { recursive: true });
  put(runtime, 'sync/recovery.filter', '');
  const config = join(directory, 'rclone.conf');
  const setup = `set -euo pipefail
USER_HOME=${JSON.stringify(home)}
USER_WORKSPACE="$USER_HOME/workspace"
USER_CLAUDE_DIR="$USER_HOME/.claude"
CODEFLARE_RUNTIME_ROOT=${JSON.stringify(runtime)}
SYNC_RUNTIME_DIR="$CODEFLARE_RUNTIME_ROOT/sync"
MANAGED_RESOURCE_FILTER_FILE="$SYNC_RUNTIME_DIR/managed.filter"
RECOVERY_FILTER_FILE="$SYNC_RUNTIME_DIR/recovery.filter"
RCLONE_CONFIG=${JSON.stringify(config)}
R2_BUCKET_NAME=bucket
R2_SSE_DISABLED=true
MANAGED_RESOURCE_POLICY=mutable
REMOTE_CURATION_ACTIVE=false
SESSION_MODE=default
SESSION_ID=restart-fixture
SYNC_MODE=full
SYNC_POLICY_MODE=include
RCLONE_CONFIG_RESULT=0
SYNC_ERROR=null
ENTERPRISE_MODE=
CODEFLARE_CODING_AGENTS=claude-code,pi
AGENT_SEED_BAKE_DIR=${JSON.stringify(join(directory, 'bake'))}
CODING_AGENT_SELECTOR=${JSON.stringify(join(root, 'scripts/ci/coding-agent-selection.mjs'))}
${filters}
${policy}
source ${JSON.stringify(join(root, 'scripts/rclone-conflict-cleanup.sh'))}
${['initial_sync_from_r2', 'run_initial_r2_restore', 'validate_coding_agent_selection', 'coding_agent_is_selected', 'lay_down_agent_seed_preseed', 'repair_hook_exec_bits', 'record_sync_disk_failure', 'establish_bisync_baseline', 'bisync_with_r2', 'update_sync_status'].map(shellFunction).join('\n')}
cleanup_main_transcripts() { :; }
cleanup_remote_pi_transcript_conflicts() { :; }
`;
  const run = async commands => {
    try {
      return await exec('bash', ['-c', `${setup}\n${commands}`], {
        timeout: 45000, maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: directory, LANG: 'C.UTF-8' },
      });
    } catch (error) {
      throw new Error(`Shell fixture failed (${error.code}):\n${error.stdout}\n${error.stderr}`);
    }
  };
  return { directory, home, runtime, config, put, run };
}

// Reuse the existing scripts/ci/rclone-bisync-s3.py boundary: rclone serve s3,
// disposable backing store and dummy credentials. The forwarding peer records
// actual object payload reads (not rclone summaries or copied local trees).
async function s3Fixture(t, fx) {
  const backendRoot = join(fx.directory, 's3');
  mkdirSync(join(backendRoot, 'bucket'), { recursive: true });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const binary = process.env.RCLONE_S3_FIXTURE_BINARY || 'rclone';
  let serverLog = '';
  const server = spawn(binary, ['serve', 's3', backendRoot, '--addr', `127.0.0.1:${port}`, '--config', '/dev/null'], {
    env: { PATH: process.env.PATH, HOME: fx.home, TMPDIR: fx.directory }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  let spawnError;
  server.on('error', error => { spawnError = error; });
  t.after(async () => {
    if (server.exitCode === null && !spawnError) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (spawnError || server.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.arrayBuffer();
      ready = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.ok(ready, `Existing rclone S3 fixture unavailable: ${spawnError || serverLog}`);
  const reads = [];
  const writes = [];
  const proxy = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://fixture');
    if (incoming.method === 'GET' && !url.searchParams.has('list-type') && !url.searchParams.has('delimiter')) {
      reads.push(decodeURIComponent(url.pathname));
    }
    if (incoming.method === 'PUT') writes.push({
      path: decodeURIComponent(url.pathname), time: incoming.headers['x-amz-meta-codeflare-hermes-written-at'],
    });
    // Same server-time emulation as the existing Python S3 fixture: the
    // filesystem backend otherwise maps client mtime metadata onto LastModified.
    const headers = { ...incoming.headers };
    delete headers['x-amz-meta-mtime'];
    delete headers.authorization;
    const forwarded = request({ hostname: '127.0.0.1', port, path: incoming.url,
      method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    forwarded.on('error', error => { outgoing.destroy(error); });
    incoming.pipe(forwarded);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  writeFileSync(fx.config, `[r2]\ntype = s3\nprovider = Other\naccess_key_id = fixture\nsecret_access_key = fixture\nendpoint = http://127.0.0.1:${proxy.address().port}\nforce_path_style = true\nno_check_bucket = true\n`);
  return { reads, writes };
}

it('REQ-MEM-042 AC2: scoped S3 upload stamps only new or changed Hermes bytes', async t => {
  const fx = fixture(t);
  const { writes } = await s3Fixture(t, fx);
  const prefix = 'Vault/Memory/Sessions/session1234';
  const memory = `${prefix}/global/MEMORY.md`;
  const files = {
    [memory]: 'Original', [`${prefix}/global/USER.md`]: '', [`${prefix}/global/failures.md`]: '',
    [`${prefix}/Projects/workspace/MEMORY.md`]: 'Workspace facts', [`${prefix}/session-id`]: 'session1234\n',
  };
  for (const [key, content] of Object.entries(files)) fx.put(fx.home, key, content);
  const upload = () => fx.run(`SESSION_ID=session1234\n: > "$MANAGED_RESOURCE_FILTER_FILE"\ntransfer_pi_hermes_memory upload direct "$((SECONDS + 30))"`);
  await upload();
  assert.deepEqual(writes.map(write => write.path).sort(), Object.keys(files).map(key => `/bucket/${key}`).sort());
  for (const write of writes) assert.match(write.time ?? '', /^\d{13}$/);
  const initial = writes.find(write => write.path === `/bucket/${memory}`);
  writes.length = 0;
  await upload();
  assert.deepEqual(writes, [], 'unchanged files must not receive a refreshed stamp');
  fx.put(fx.home, memory, '');
  await upload();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `/bucket/${memory}`);
  assert.ok(Number(writes[0].time) > Number(initial.time));
  const readback = await fx.run(`rclone cat r2:bucket/${memory} --config "$RCLONE_CONFIG"`);
  assert.equal(readback.stdout, '');
});

it('REQ-STOR-002 AC1/AC2/AC3: S3 restores ordinary, config, dotfile and full-workspace bytes after first local runtime is discarded', async t => {
  const fx = fixture(t);
  await s3Fixture(t, fx);
  const payloads = {
    'Uploads/nonempty.bin': Buffer.from([0, 255, 10, 1, 128]),
    '.claude/settings.json': Buffer.from('{"theme":"user-owned"}\n'),
    '.profile': Buffer.from('export RESTORED_USER_SETTING=yes\n'),
    'workspace/repo/nested/untracked.txt': Buffer.from('full workspace: not a cloned repository\n'),
  };
  // First lifecycle establishes real S3 state, then publishes session writes.
  await fx.run('printf "baseline sentinel\\n" | rclone rcat r2:bucket/Uploads/initial.txt --config "$RCLONE_CONFIG"\ninitial_sync_from_r2\nestablish_bisync_baseline');
  for (const [path, bytes] of Object.entries(payloads)) fx.put(fx.home, path, bytes);
  await fx.run('bisync_with_r2 ""');
  for (const [path, bytes] of Object.entries(payloads)) {
    const restored = await fx.run(`rclone cat ${JSON.stringify(`r2:bucket/${path}`)} --config "$RCLONE_CONFIG" | base64 -w0`);
    assert.deepEqual(Buffer.from(restored.stdout, 'base64'), bytes, `independent S3 readback: ${path}`);
  }
  rmSync(fx.home, { recursive: true });
  rmSync(fx.runtime, { recursive: true });
  assert.equal(existsSync(fx.home), false);
  assert.equal(existsSync(fx.runtime), false);
  mkdirSync(fx.home);
  mkdirSync(join(fx.runtime, 'sync/rclone'), { recursive: true });
  fx.put(fx.runtime, 'sync/recovery.filter', '');
  // A new shell has no previous flags/listings; only S3 retains user bytes.
  await fx.run('run_initial_r2_restore\ntest "$STEP1_RESULT" = 0');
  for (const [path, bytes] of Object.entries(payloads)) {
    assert.deepEqual(readFileSync(join(fx.home, path)), bytes, `replacement restore: ${path}`);
  }
});

it('REQ-STOR-256 AC2: checksum restore skips unchanged baked payload and downloads changed same-size remote bytes', async t => {
  const fx = fixture(t);
  const peer = await s3Fixture(t, fx);
  const same = '.claude/skills/unchanged/SKILL.md';
  const changed = '.claude/skills/changed/SKILL.md';
  fx.put(fx.home, same, 'unchanged baked skill\n');
  fx.put(fx.home, changed, 'remote skill\n');
  await fx.run('compose_rclone_filters\nrclone copy "$USER_HOME" r2:bucket --config "$RCLONE_CONFIG" "${RCLONE_EFFECTIVE_FILTERS[@]}"');
  rmSync(fx.home, { recursive: true });
  mkdirSync(fx.home);
  fx.put(join(fx.directory, 'bake/default'), same, 'unchanged baked skill\n');
  fx.put(join(fx.directory, 'bake/default'), changed, 'baked! skill\n');
  for (const path of [same, changed]) utimesSync(join(fx.directory, 'bake/default', path), 1, 1);
  peer.reads.length = 0;
  await fx.run('run_initial_r2_restore\ntest "$STEP1_RESULT" = 0');
  assert.equal(readFileSync(join(fx.home, same), 'utf8'), 'unchanged baked skill\n');
  assert.equal(readFileSync(join(fx.home, changed), 'utf8'), 'remote skill\n');
  assert.equal(peer.reads.includes(`/bucket/${same}`), false, 'unchanged seed must not transfer its payload');
  assert.ok(peer.reads.includes(`/bucket/${changed}`), 'positive control: changed seed payload must transfer');
});

it('REQ-STOR-256 AC3: relayed Pi extension loads from the real Jiti cache in a fresh process', async t => {
  const fx = fixture(t);
  // Use an existing repository installation, or the image's installed Pi loader.
  // No install and no synthetic transpiler fallback; absence is an explicit limit.
  const require = createRequire(import.meta.url);
  let jiti;
  try {
    jiti = require.resolve('jiti', { paths: [join(root, 'host'), join(root, 'preseed/agents/pi'),
      '/opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent'] });
  } catch {
    t.skip('Existing Jiti artifact unavailable');
    return;
  }
  const extensionName = '00-smart-compact-config.ts';
  const bytes = readFileSync(join(root, 'preseed/agents/pi/extensions', extensionName));
  const extension = join(fx.home, '.pi/agent/extensions', extensionName);
  fx.put(fx.home, `.pi/agent/extensions/${extensionName}`, bytes);
  fx.put(fx.directory, `warm/${extensionName}`, bytes);
  const loader = join(fx.directory, 'load.cjs');
  writeFileSync(loader, `const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createJiti } = require(${JSON.stringify(jiti)});
const loader = createJiti(__filename, { moduleCache: false, fsCache: ${JSON.stringify(join(fx.directory, 'jiti'))}, debug: true });
loader.import(${JSON.stringify(extension)}).then(module => {
  assert.equal(module.configureSmartCompact(${JSON.stringify(join(fx.home, '.pi/agent'))}), true);
  const settings = JSON.parse(fs.readFileSync(${JSON.stringify(join(fx.home, '.pi/agent/settings.json'))}, 'utf8'));
  assert.equal(settings.smartCompact.mode, 'thorough');
  console.log('managed extension loaded');
}).catch(error => { console.error(error); process.exitCode = 1; });
`);
  const load = () => exec(process.execPath, [loader], { timeout: 10000,
    env: { PATH: process.env.PATH, HOME: fx.home, TMPDIR: fx.directory } });
  const cold = await load();
  assert.match(cold.stdout, /managed extension loaded/);
  assert.match(cold.stderr + cold.stdout, /\[cache\] \[miss\].*00-smart-compact-config\.ts/);
  // Simulate stale restored bytes, then run the production image-authoritative relay.
  writeFileSync(extension, '// stale remote extension\n');
  await fx.run(`${shellFunction('relay_managed_pi_extensions')}\nPI_WARM_EXTENSIONS_DIR=${JSON.stringify(join(fx.directory, 'warm'))}\nrelay_managed_pi_extensions`);
  assert.deepEqual(readFileSync(extension), bytes);
  const warm = await load();
  assert.match(warm.stdout, /managed extension loaded/);
  assert.match(warm.stderr + warm.stdout, /\[cache\] \[hit\].*00-smart-compact-config\.ts.*~>/);
  assert.doesNotMatch(warm.stderr + warm.stdout, /\[cache\] \[miss\]/);
});

it('REQ-STOR-002 AC4: restore completes before boot repair; actual chmod failure is nonfatal at startup and successful bisync', async t => {
  const fx = fixture(t);
  const hook = join(fx.home, '.claude/hooks/deep/run.sh');
  const events = join(fx.directory, 'events');
  const tools = join(fx.directory, 'bin');
  mkdirSync(tools);
  writeFileSync(join(tools, 'chmod'), `#!/bin/sh\nprintf 'chmod-failed:%s\\n' "$*" >> ${JSON.stringify(events)}\nexit 1\n`, { mode: 0o755 });
  const managedStartup = shellFunction('run_managed_curation_startup');
  const result = await fx.run(`
PATH=${JSON.stringify(tools)}:"$PATH"
timeout() { shift; "$@"; }
${managedStartup}
# The transport peer creates the hook during restore, not before startup.
rclone() {
  if [ "$1" = sync ]; then
    mkdir -p ${JSON.stringify(dirname(hook))}
    printf '#!/bin/sh\\nprintf restored-hook\\n' > ${JSON.stringify(hook)}
    printf 'restored\\n' >> ${JSON.stringify(events)}
  fi
  return 0
}
run_post_restore_startup() {
  test "$STEP1_RESULT" = 0
  test -s ${JSON.stringify(hook)}
  ${bootRepair}
  printf 'startup-continued\\n' >> ${JSON.stringify(events)}
}
complete_managed_curation_startup() { printf 'complete\\n' >> ${JSON.stringify(events)}; }
run_managed_curation_startup
bisync_with_r2 ""
printf 'bisync-continued\\n' >> ${JSON.stringify(events)}
`);
  assert.equal(result.stderr.includes('unbound variable'), false, result.stderr);
  const outcomes = readFileSync(events, 'utf8').trim().split('\n');
  assert.equal(outcomes[0], 'restored');
  assert.match(outcomes[1], /^chmod-failed:0755 .*\/hooks\/deep\/run.sh$/);
  assert.equal(outcomes[2], 'startup-continued');
  assert.equal(outcomes[3], 'complete');
  assert.match(outcomes[4], /^chmod-failed:0755 .*\/hooks\/deep\/run.sh$/);
  assert.equal(outcomes[5], 'bisync-continued');
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nprintf restored-hook\n');
  assert.equal(statSync(hook).mode & 0o111, 0, 'failed repair did not make the hook executable');
});

it('REQ-STOR-004 AC7: exhausted ordinary baseline failure still starts a live sync daemon', async t => {
  const fx = fixture(t);
  const start = source.indexOf('\n            if establish_bisync_baseline; then');
  const end = source.indexOf('\n            start_sync_daemon', start);
  assert.ok(start >= 0 && end > start);
  const startup = source.slice(start, end) + '\nstart_sync_daemon';
  const result = await fx.run(`
${shellFunction('start_sync_daemon')}
timeout() { shift; "$@"; }
# The failed transport has exhausted its retry budget; no disk-space or
# vanished-file classification applies. The production baseline owns the exit.
rclone() { case "$1" in delete) return 0;; *) echo 'ordinary transport failure after retries'; return 5;; esac; }
recover_vanished_files() { return 1; }
init_user_vault() { :; }
run_daily_vault_session_compaction() { echo unexpected-compaction; return 1; }
sleep() { echo "$BASHPID" > "$SYNC_RUNTIME_DIR/sleeper.pid"; exec /usr/bin/sleep "$@"; }
BASELINE_SUCCEEDED=0
${startup}
trap 'kill "$SYNC_DAEMON_PID" 2>/dev/null || true; if [ -f "$SYNC_RUNTIME_DIR/sleeper.pid" ]; then kill "$(cat "$SYNC_RUNTIME_DIR/sleeper.pid")" 2>/dev/null || true; fi; wait "$SYNC_DAEMON_PID" 2>/dev/null || true' EXIT
for attempt in $(seq 1 100); do
  [ ! -f "$SYNC_RUNTIME_DIR/sleeper.pid" ] || break
  /usr/bin/sleep 0.01
done
test -s "$SYNC_RUNTIME_DIR/sleeper.pid"
kill -0 "$SYNC_DAEMON_PID"
printf 'daemon-alive:%s baseline:%s status:%s\\n' "$SYNC_DAEMON_PID" "$BASELINE_SUCCEEDED" "$SYNC_STATUS"
`);
  assert.match(result.stdout, /daemon-alive:\d+ baseline:0 status:failed/);
  assert.equal(existsSync(join(fx.runtime, 'sync/bisync-initialized')), false);
  assert.equal(existsSync(join(fx.runtime, 'sync/disk-space-blocked')), false);
  assert.doesNotMatch(result.stdout, /unexpected-compaction/);
  assert.match(readFileSync(join(fx.runtime, 'sync/sync.log'), 'utf8'), /ordinary transport failure after retries/);
});
