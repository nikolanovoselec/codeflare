import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = '/opt/codeflare/openvscode';
const EXTENSION_NAME = 'codeflare-agent-sidebar';

async function main() {
  const inventoriesRoot = join(ROOT, 'extensions');
  assert.deepEqual((await readdir(inventoriesRoot)).sort(), ['claude', 'none', 'pi']);
  assert.deepEqual(await readdir(join(inventoriesRoot, 'none')), []);

  const packaged = [];
  for (const inventory of ['pi', 'claude']) {
    const inventoryRoot = join(inventoriesRoot, inventory);
    assert.deepEqual(await readdir(inventoryRoot), [EXTENSION_NAME]);
    const extensionRoot = join(inventoryRoot, EXTENSION_NAME);
    const manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, EXTENSION_NAME);
    assert.equal(manifest.publisher, 'codeflare');
    assert.equal(manifest.main, './dist/extension.cjs');
    await assertImmutable(extensionRoot);
    packaged.push(extensionRoot);
  }

  const piMain = join(packaged[0], 'dist', 'extension.cjs');
  const claudeMain = join(packaged[1], 'dist', 'extension.cjs');
  assert.equal((await stat(piMain)).ino, (await stat(claudeMain)).ino);
  const extensionHash = createHash('sha256').update(await readFile(piMain)).digest('hex');
  assert.equal((await collect(ROOT)).some((path) => path.toLowerCase().endsWith('.vsix')), false);

  const managedModule = await import(pathToFileURL(join(ROOT, 'claude', 'managed-settings.mjs')).href);
  const managedSettings = managedModule.buildManagedSettings();
  const optSettings = JSON.parse(await readFile(join(ROOT, 'claude', 'sidebar-settings.json'), 'utf8'));
  const etcSettings = JSON.parse(await readFile('/etc/codeflare/claude-sidebar/settings.json', 'utf8'));
  assert.deepEqual(optSettings, managedSettings);
  assert.deepEqual(etcSettings, managedSettings);
  assert.equal(managedSettings.permissions.defaultMode, 'default');
  assert.equal(managedSettings.disableBypassPermissionsMode, 'disable');

  await verifyConfigProjection();
  await verifyPermissionHook();
  const abi = verifyNativeAddon(packaged[0]);
  const claudeVersion = execFileSync('/usr/local/bin/claude', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const piVersion = execFileSync('/usr/local/bin/pi', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();

  process.stdout.write(`${JSON.stringify({
    result: 'SIDEBAR_IMAGE_SMOKE_OK',
    extensionHash,
    abi,
    claudeVersion,
    piVersion,
  })}\n`);
}

async function verifyConfigProjection() {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-image-smoke-'));
  try {
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, '.credentials.json'), 'image-smoke-secret-canary\n', { mode: 0o600 });
    await writeFile(join(sourceRoot, 'history.jsonl'), 'terminal-history-must-not-project\n');
    const module = await import(pathToFileURL(join(ROOT, 'claude', 'prepare-sidebar-config.mjs')).href);
    await module.prepareSidebarConfig({ sourceRoot, targetRoot });
    assert.equal((await lstat(join(targetRoot, '.credentials.json'))).isSymbolicLink(), true);
    assert.equal(await readlink(join(targetRoot, '.credentials.json')), join(sourceRoot, '.credentials.json'));
    await assert.rejects(lstat(join(targetRoot, 'history.jsonl')), { code: 'ENOENT' });
    assert.equal((await stat(targetRoot)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyPermissionHook() {
  const hook = await import(pathToFileURL(join(ROOT, 'claude', 'pre-tool-use-permission.mjs')).href);
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} });
  const outcome = await hook.runPreToolUse(input);
  assert.equal(outcome.exitCode, 0);
  assert.equal(JSON.parse(outcome.stdout).hookSpecificOutput.permissionDecision, 'ask');
  const failed = await hook.runPreToolUse(input, { evaluate: () => { throw new Error('canary'); } });
  assert.equal(failed.exitCode, 2);
}

function verifyNativeAddon(extensionRoot) {
  const node = '/opt/openvscode-server/node';
  const script = String.raw`
    const { createRequire } = require('node:module');
    const packagePath = process.argv[1];
    if (process.versions.modules !== '127') throw new Error('unexpected ABI ' + process.versions.modules);
    const pty = createRequire(packagePath)('node-pty');
    if (typeof pty.spawn !== 'function') throw new Error('node-pty did not load');
    process.stdout.write(process.version + ' ABI=' + process.versions.modules);
  `;
  return execFileSync(node, ['-e', script, join(extensionRoot, 'package.json')], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
}

async function assertImmutable(root) {
  for (const path of await collect(root)) {
    const info = await lstat(path);
    assert.equal(info.mode & 0o222, 0, `${path} is writable`);
  }
}

async function collect(root, output = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    output.push(path);
    if (entry.isDirectory()) await collect(path, output);
  }
  return output;
}

main().catch((error) => {
  process.stderr.write(`SIDEBAR_IMAGE_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
