#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LANES = new Set(['code-reviewer', 'spec-reviewer', 'doc-updater']);
const ROOT_DOC = /^(README|CHANGELOG|CONTRIBUTING|SECURITY)\.md$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

function git(repo, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: repo,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function isGenerated(path) {
  return path.startsWith('graphify-out/')
    || path.includes('/node_modules/')
    || /(^|\/)(dist|build|coverage)\//.test(path)
    || path === 'src/lib/agent-seed.generated.ts';
}

function owns(lane, path) {
  if (isGenerated(path)) return false;
  if (lane === 'spec-reviewer') return path.startsWith('sdd/');
  if (lane === 'doc-updater') return path.startsWith('documentation/') || ROOT_DOC.test(path);
  return !path.startsWith('sdd/') && !path.startsWith('documentation/') && !ROOT_DOC.test(path);
}

function nulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).sort();
}

function validateRange(repo, range) {
  const [base, head, extra] = String(range ?? '').split('..');
  if (extra !== undefined || !FULL_SHA.test(base ?? '') || !FULL_SHA.test(head ?? '')) {
    throw new Error('diff scope requires a valid ancestor range');
  }
  try {
    git(repo, ['merge-base', '--is-ancestor', base, head]);
  } catch {
    throw new Error('diff scope requires a valid ancestor range');
  }
  return `${base}..${head}`;
}

export function buildReviewPacket({ repo, scope, range, lane }) {
  if (scope !== 'diff' && scope !== 'all') throw new Error('scope must be diff or all');
  if (!LANES.has(lane)) throw new Error('lane must be code-reviewer, spec-reviewer, or doc-updater');

  if (scope === 'all') {
    const tracked = nulList(git(repo, ['ls-files', '-z'], 'buffer'));
    return {
      scope,
      workSet: 'whole-requested-tree',
      lane,
      range: undefined,
      files: tracked.filter((path) => owns(lane, path)),
      changedInputs: [],
      patch: '',
    };
  }

  const validRange = validateRange(repo, range);
  const changed = nulList(git(repo, ['diff', '--name-only', '--no-renames', '-z', validRange], 'buffer'))
    .filter((path) => !isGenerated(path));
  const files = changed.filter((path) => owns(lane, path));
  const patch = files.length === 0
    ? ''
    : String(git(repo, ['diff', '--no-renames', '--unified=3', validRange, '--', ...files]));
  return {
    scope,
    workSet: 'changed-hunks-and-direct-invalidations',
    lane,
    range: validRange,
    files,
    changedInputs: changed.filter((path) => !files.includes(path)),
    patch,
  };
}

export function persistReviewPacket(packet, { directory = join(tmpdir(), 'codeflare-review-packets') } = {}) {
  const serialized = JSON.stringify(packet);
  const digest = createHash('sha256').update(serialized).digest('hex');
  mkdirSync(directory, { recursive: true });
  const packetPath = join(directory, `${digest}.json`);
  writeFileSync(packetPath, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    scope: packet.scope,
    workSet: packet.workSet,
    lane: packet.lane,
    range: packet.range,
    packetPath,
    packetSha256: digest,
    patchBytes: Buffer.byteLength(packet.patch ?? ''),
    fileCount: packet.files.length,
    changedInputCount: packet.changedInputs.length,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    values[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const packet = buildReviewPacket({
      repo: args.repo,
      scope: args.scope,
      range: args.range,
      lane: args.lane,
    });
    process.stdout.write(`${JSON.stringify(persistReviewPacket(packet))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
