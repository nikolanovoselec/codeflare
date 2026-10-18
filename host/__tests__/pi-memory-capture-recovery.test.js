// Behavioral CLI coverage: a post-commit pair is a receipt, not permission to republish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../preseed/agents/pi/scripts/', import.meta.url));
const HELPER = path.join(scripts, 'recover-memory-capture.py');
const BUILDER = path.join(scripts, 'build-memory-graph.py');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-capture-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'Vault');
  const varsFile = path.join(root, 'capture.vars');
  const request = {
    version: 1,
    requestId: '00000000-0000-4000-8000-000000000001',
    sessionId: 'session-1',
    promptCount: 20,
    captureTimestamp: '2026-07-14T10-00-00',
    captureFilename: '2026-07-14T10-00-00-session-1.md',
    transcript: '## user\nKeep REQ-MEM-014 and commit 98c4bb79 verbatim.',
  };
  const target = path.join(vault, 'Raw', 'Sessions', request.captureFilename);
  const chunk = path.join(vault, 'graphify-out', `.graphify_chunk_${request.requestId}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.dirname(chunk), { recursive: true });
  fs.writeFileSync(varsFile, JSON.stringify(request));
  // These files belong to the root/publisher and must be byte-preserved, not consulted or advanced.
  fs.writeFileSync(path.join(root, 'session-1.count'), '0\n');
  fs.writeFileSync(path.join(root, 'session-1.vars'), JSON.stringify({ version: 1, requestId: request.requestId }));
  fs.writeFileSync(path.join(vault, 'graphify-out', 'vault-graph.json'), '{"nodes":[],"links":[]}\n');
  fs.writeFileSync(path.join(vault, 'graphify-out', 'graph.json'), '{"nodes":[],"links":[]}\n');
  fs.writeFileSync(path.join(vault, 'Raw', 'Sessions', 'Archive.md'), '# Deterministic archive: do not touch\n');
  const note = [
    '---',
    `session_id: ${request.sessionId}`,
    `captured_at: ${JSON.stringify(request.captureTimestamp)}`,
    `captured_prompt_count: ${request.promptCount}`,
    'captured_chunks: 1',
    '---',
    '# Session - Published before native abort',
    '',
    '- Preserve [[Memory Capture]] alongside [[Native Completion]].',
    '- Preserve REQ-MEM-014 and 98c4bb79.',
    '',
  ].join('\n');
  return { root, vault, varsFile, request, target, chunk, note };
}

function buildChunk(f) {
  const result = spawnSync('python3', [BUILDER, f.target, f.target, f.chunk], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, `real deterministic builder: ${result.stderr}`);
}

function publishPair(f, note = f.note) {
  fs.writeFileSync(f.target, note);
  buildChunk(f);
}

function snapshot(root) {
  const entries = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const entry = path.join(directory, name);
      const stat = fs.lstatSync(entry);
      const relative = path.relative(root, entry);
      if (stat.isSymbolicLink()) entries.push([relative, 'symlink', fs.readlinkSync(entry)]);
      else if (stat.isDirectory()) { entries.push([relative, 'directory']); visit(entry); }
      else if (stat.isFile()) entries.push([relative, 'file', stat.mode, stat.mtimeMs, fs.readFileSync(entry).toString('base64')]);
      else entries.push([relative, 'special', stat.mode]);
    }
  }
  visit(root);
  return entries;
}

function recover(f) {
  return spawnSync('python3', [HELPER, f.varsFile, f.vault], {
    encoding: 'utf8', timeout: 3_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

function rejectUnchanged(f) {
  const before = snapshot(f.root);
  const result = recover(f);
  assert.equal(result.error, undefined, `must reject without blocking: ${result.error}`);
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.status, 0, 'unsafe or incomplete receipt must fail closed');
  assert.equal(result.stdout.includes('RECOVERED'), false, 'must not return a success receipt');
  assert.deepEqual(snapshot(f.root), before, 'rejection must not modify, create, or delete any fixture artifact');
}

test('REQ-MEM-021: recovers an exact published note and real deterministic chunk read-only and idempotently', (t) => {
  const f = fixture(t);
  publishPair(f);
  // Recovery must not need Graphify, network publication, or even graph stores to be readable JSON.
  fs.writeFileSync(path.join(f.vault, 'graphify-out', 'vault-graph.json'), 'not consulted\n');
  fs.writeFileSync(path.join(f.vault, 'graphify-out', 'graph.json'), 'not consulted either\n');
  fs.chmodSync(f.target, 0o444);
  fs.chmodSync(f.chunk, 0o444);
  const before = snapshot(f.root);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = recover(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `RECOVERED ${f.target}\n`);
    assert.deepEqual(snapshot(f.root), before, 'recovery may only read the frozen request and receipt');
  }
});

test('REQ-MEM-020: missing both published artifacts returns NOT_PUBLISHED without starting publication', (t) => {
  const f = fixture(t);
  fs.writeFileSync(`${f.chunk}.work`, '{"unfinished":true}\n');
  fs.writeFileSync(path.join(path.dirname(f.chunk), '.graphify_chunk_00000000-0000-4000-8000-000000000002.json'), '{}\n');
  const before = snapshot(f.root);
  const result = recover(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'NOT_PUBLISHED\n');
  assert.deepEqual(snapshot(f.root), before);
});

for (const missing of ['note', 'chunk']) {
  test(`REQ-MEM-021: rejects a partial post-commit receipt missing its ${missing}`, (t) => {
    const f = fixture(t);
    publishPair(f);
    fs.unlinkSync(missing === 'note' ? f.target : f.chunk);
    rejectUnchanged(f);
  });
}

for (const [field, replacement] of [
  ['session_id', 'another-session'],
  ['captured_at', '2026-07-14T11-00-00'],
  ['captured_prompt_count', '21'],
]) {
  test(`REQ-MEM-021: rejects a deterministic pair whose note ${field} differs from the frozen request`, (t) => {
    const f = fixture(t);
    publishPair(f, f.note.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: ${replacement}`));
    // The chunk is valid for this note, but the note is not valid for this request.
    rejectUnchanged(f);
  });
}

for (const variant of ['missing identity', 'duplicate identity', 'body-only identity', 'malformed count']) {
  test(`REQ-MEM-021: rejects ${variant} rather than trusting plausible note prose`, (t) => {
    const f = fixture(t);
    const notes = {
      'missing identity': f.note.replace(/^captured_at:.*\n/m, ''),
      'duplicate identity': f.note.replace('session_id: session-1', 'session_id: another-session\nsession_id: session-1'),
      'body-only identity': f.note.replace(/^---\n[\s\S]*?\n---\n/, '# Not frontmatter\n'),
      'malformed count': f.note.replace('captured_prompt_count: 20', 'captured_prompt_count: 20.5'),
    };
    publishPair(f, notes[variant]);
    rejectUnchanged(f);
  });
}

for (const mutation of ['wrong source', 'missing concept', 'missing edge', 'extra edge', 'extra field', 'malformed JSON']) {
  test(`REQ-MEM-021: rejects ${mutation} in the named chunk instead of accepting schema alone`, (t) => {
    const f = fixture(t);
    publishPair(f);
    const graph = JSON.parse(fs.readFileSync(f.chunk, 'utf8'));
    if (mutation === 'wrong source') graph.nodes[0].source_file = path.join(f.vault, 'Raw', 'Sessions', 'other.md');
    if (mutation === 'missing concept') graph.nodes.pop();
    if (mutation === 'missing edge') graph.edges.pop();
    if (mutation === 'extra edge') graph.edges.push({ ...graph.edges[0], relation: 'cites' });
    if (mutation === 'extra field') graph.untrusted_receipt = true;
    fs.writeFileSync(f.chunk, mutation === 'malformed JSON' ? '{broken' : JSON.stringify(graph));
    rejectUnchanged(f);
  });
}

test('REQ-MEM-021: refuses reserved Archive.md even when its metadata and deterministic chunk match', (t) => {
  const f = fixture(t);
  f.request.captureFilename = 'Archive.md';
  f.target = path.join(f.vault, 'Raw', 'Sessions', 'Archive.md');
  fs.writeFileSync(f.varsFile, JSON.stringify(f.request));
  publishPair(f);
  rejectUnchanged(f);
});

for (const [field, value] of [
  ['captureFilename', '../escape.md'],
  ['captureFilename', '/tmp/escape.md'],
  ['captureFilename', '..\\escape.md'],
  ['requestId', '../escape'],
  ['sessionId', '../escape'],
  ['promptCount', -1],
  ['promptCount', '20'],
  ['version', 2],
]) {
  test(`REQ-MEM-014 / REQ-MEM-021: rejects unsafe frozen ${field}=${JSON.stringify(value)} before artifact access`, (t) => {
    const f = fixture(t);
    fs.writeFileSync(f.varsFile, JSON.stringify({ ...f.request, [field]: value }));
    rejectUnchanged(f);
  });
}

test('REQ-MEM-014: rejects malformed request JSON without changing root-owned files', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.varsFile, '{broken');
  rejectUnchanged(f);
});

for (const component of ['note', 'chunk', 'sessions directory', 'graph directory']) {
  test(`REQ-MEM-021: rejects an outside-Vault symlink at the ${component} without touching its destination`, (t) => {
    const f = fixture(t);
    publishPair(f);
    const location = component === 'note' ? f.target : component === 'chunk' ? f.chunk
      : component === 'sessions directory' ? path.dirname(f.target) : path.dirname(f.chunk);
    const outside = path.join(f.root, 'outside');
    fs.renameSync(location, outside);
    fs.symlinkSync(outside, location);
    rejectUnchanged(f);
  });
}

for (const component of ['note', 'chunk']) {
  test(`REQ-MEM-021: refuses an escaped ${component} FIFO before reading outside the Vault`, (t) => {
    const f = fixture(t);
    publishPair(f);
    const fifo = path.join(f.root, 'outside-fifo');
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 3_000 });
    assert.equal(made.status, 0, made.stderr);
    const location = component === 'note' ? f.target : f.chunk;
    fs.unlinkSync(location);
    fs.symlinkSync(fifo, location);
    // Reading the escaped destination would block and time out, not return a normal refusal.
    rejectUnchanged(f);
  });
}
