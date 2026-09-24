import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runApprovedPacket } from '../dist/operator-approved-packet.js';

const script = fileURLToPath(new URL('../../preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs', import.meta.url));

function git(repo, args, input) {
  const result = spawnSync('git', ['-C', repo, ...args], { input, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

async function fixture(t, { unsafeLink = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'approved-packet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'source');
  await mkdir(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'src/app.ts'), 'export const value = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  await writeFile(path.join(repo, 'src/app.ts'), 'export const value = 2;\n');
  await mkdir(path.join(repo, '.githooks'));
  await writeFile(path.join(repo, '.githooks/post-checkout'), `#!/bin/sh\necho ran > '${path.join(root, 'hook-ran')}'\n`, { mode: 0o755 });
  await writeFile(path.join(repo, '.gitconfig'), '[core]\n\thooksPath = .githooks\n');
  await writeFile(path.join(repo, '.gitattributes'), '*.ts diff=run-candidate\n');
  await mkdir(path.join(repo, 'preseed/agents/claude/skills/review-scope/scripts'), { recursive: true });
  await writeFile(path.join(repo, 'preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs'),
    'throw Error("candidate script executed");\n');
  if (unsafeLink) await symlink('/proc/self/environ', path.join(repo, 'src/escape'));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'review head']);
  const head = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  const pack = git(repo, ['pack-objects', '--stdout', '--revs'], Buffer.from(`${head}\n`));
  return { root, base, head, pack };
}

function binding(f, overrides = {}) {
  return { pack: f.pack, head: f.head, acknowledgedHead: f.base,
    lane: 'code-reviewer', deadline: Date.now() + 60_000,
    maxPackBytes: 16 * 1024 * 1024, maxCheckoutBytes: 32 * 1024 * 1024,
    maxOutputBytes: 8 * 1024 * 1024, ...overrides };
}

async function run(f, overrides = {}, options = {}) {
  return runApprovedPacket(binding(f, overrides), { root: f.root, scriptPath: script, ...options });
}

test('REQ-OPERATOR-050/053: trusted script builds the exact acknowledged-head packet from received Git objects', async t => {
  const f = await fixture(t);
  const packet = JSON.parse(Buffer.from(await run(f)).toString('utf8'));
  assert.equal(packet.scope, 'diff');
  assert.equal(packet.range, `${f.base}..${f.head}`);
  assert.ok(packet.files.includes('src/app.ts'));
  assert.match(packet.patch, /\+export const value = 2;/);
  const wholeTree = JSON.parse(Buffer.from(await run(f, { acknowledgedHead: null })).toString('utf8'));
  assert.equal(wholeTree.scope, 'all');
  assert.ok(wholeTree.files.includes('src/app.ts'));
  await assert.rejects(readFile(path.join(f.root, 'hook-ran')));
});

test('REQ-OPERATOR-050/053: wrong head, missing ancestor and corrupt pack never yield a packet', async t => {
  const f = await fixture(t);
  await assert.rejects(run(f, { head: 'a'.repeat(40) }));
  await assert.rejects(run(f, { acknowledgedHead: 'b'.repeat(40) }));
  await assert.rejects(run(f, { pack: Buffer.from('not a Git pack') }));
});

test('REQ-OPERATOR-050/053: hostile checkout symlinks and candidate scripts cannot become packet authority', async t => {
  const f = await fixture(t, { unsafeLink: true });
  await assert.rejects(run(f));
  await assert.rejects(readFile(path.join(f.root, 'hook-ran')));
});

test('REQ-OPERATOR-050/053: expiry, cancellation and byte ceilings fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(run(f, { deadline: Date.now() - 1 }));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(run(f, {}, { signal: cancelled.signal }));
  await assert.rejects(run(f, { maxPackBytes: 16 }));
  await assert.rejects(run(f, { maxCheckoutBytes: 16 }));
  await assert.rejects(run(f, { maxOutputBytes: 16 }));
});

test('REQ-OPERATOR-050/053: the received pack cannot choose an executable, URL, checkout path or lane', async t => {
  const f = await fixture(t);
  for (const override of [
    { lane: '../outside' }, { scriptPath: path.join(f.root, 'source/.githooks/post-checkout') },
    { command: 'git push' }, { repository: 'attacker/private' },
    { url: 'https://attacker.example/git' }, { checkoutPath: f.root },
  ]) await assert.rejects(run(f, override));
});
