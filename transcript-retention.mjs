#!/usr/bin/env node

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, resolve, sep } from 'node:path';

const CHUNK_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 1024 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAUDE_FILENAME = new RegExp(`^(${UUID})\\.jsonl$`, 'i');
const PI_FILENAME = new RegExp(`_(${UUID})\\.jsonl$`, 'i');
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseTimestamp(value) {
  if (typeof value !== 'string' || !RFC3339.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseObject(line) {
  if (line.length === 0) return undefined;
  try {
    const value = JSON.parse(line.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function discoverTranscripts(root, excludedSegments) {
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];

  const transcripts = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excludedSegments.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (!path.startsWith(`${root}${sep}`)) throw new Error(`candidate escaped transcript root: ${path}`);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) transcripts.push(path);
    }
  };

  visit(root);
  return transcripts;
}

function readHeaderObjects(path) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = Number(fstatSync(file).size);
    const length = Math.min(size, MAX_SCAN_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(file, buffer, 0, length, 0);
    const data = buffer.subarray(0, bytesRead);
    const lastNewline = data.lastIndexOf(0x0a);
    const complete = bytesRead === size ? data : data.subarray(0, Math.max(0, lastNewline));
    return complete.toString('utf8').split('\n').map((line) => parseObject(Buffer.from(line))).filter(Boolean);
  } finally {
    closeSync(file);
  }
}

function readLatestTimestamp(path) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let position = Number(fstatSync(file).size);
    let scanned = 0;
    let suffix = Buffer.alloc(0);

    while (position > 0 && scanned < MAX_SCAN_BYTES) {
      const length = Math.min(CHUNK_BYTES, position, MAX_SCAN_BYTES - scanned);
      position -= length;
      scanned += length;
      const chunk = Buffer.allocUnsafe(length);
      readSync(file, chunk, 0, length, position);
      const data = Buffer.concat([chunk, suffix]);
      let lineEnd = data.length;

      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 0x0a) continue;
        const value = parseObject(data.subarray(index + 1, lineEnd));
        const timestamp = value ? parseTimestamp(value.timestamp) : undefined;
        if (timestamp !== undefined) return timestamp;
        lineEnd = index;
      }
      suffix = data.subarray(0, lineEnd);
    }

    if (position === 0) {
      const value = parseObject(suffix);
      return value ? parseTimestamp(value.timestamp) : undefined;
    }
    return undefined;
  } finally {
    closeSync(file);
  }
}

function parseClaudeTimestamp(path) {
  const match = CLAUDE_FILENAME.exec(basename(path));
  if (!match) return undefined;
  const sessionId = match[1].toLowerCase();
  const header = readHeaderObjects(path);
  const identity = header.find((record) =>
    typeof record.sessionId === 'string' &&
    record.sessionId.toLowerCase() === sessionId &&
    typeof record.version === 'string' &&
    /^2\.1\.\d+$/.test(record.version) &&
    record.isSidechain === false
  );
  if (!identity) return undefined;
  return readLatestTimestamp(path);
}

function parsePiTimestamp(path) {
  const match = PI_FILENAME.exec(basename(path));
  if (!match) return undefined;
  const sessionId = match[1].toLowerCase();
  const header = readHeaderObjects(path)[0];
  if (
    !header ||
    header.type !== 'session' ||
    header.version !== 3 ||
    typeof header.id !== 'string' ||
    header.id.toLowerCase() !== sessionId ||
    Object.hasOwn(header, 'parentSession')
  ) return undefined;
  return readLatestTimestamp(path);
}

function compareNewestFirst(left, right) {
  if (left.timestamp !== right.timestamp) return left.timestamp > right.timestamp ? -1 : 1;
  if (left.path === right.path) return 0;
  return left.path > right.path ? -1 : 1;
}

function mtimeRanking(paths) {
  const ranked = [];
  for (const path of paths) {
    try {
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      ranked.push({ path, timestamp: stat.mtimeNs });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return ranked.sort(compareNewestFirst);
}

function retainLatest(agent, paths, keepCount, parseNativeTimestamp) {
  if (paths.length <= keepCount) return;

  let mode = 'native';
  const native = [];
  for (const path of paths) {
    let timestamp;
    try {
      timestamp = parseNativeTimestamp(path);
    } catch {
      timestamp = undefined;
    }
    if (timestamp === undefined) {
      mode = 'mtime-fallback';
      break;
    }
    native.push({ path, timestamp });
  }

  const ranked = mode === 'native' ? native.sort(compareNewestFirst) : mtimeRanking(paths);
  let deleted = 0;
  for (const { path } of ranked.slice(keepCount)) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      unlinkSync(path);
      deleted += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  process.stdout.write(`[transcript-cleanup] agent=${agent} mode=${mode} candidates=${paths.length} kept=${Math.min(paths.length, keepCount)} deleted=${deleted}\n`);
}

function main() {
  const [agent, rootArgument, keepArgument] = process.argv.slice(2);
  if (agent !== 'claude' && agent !== 'pi') throw new Error(`unsupported transcript agent: ${agent ?? ''}`);
  const keepCount = Number(keepArgument);
  if (!Number.isSafeInteger(keepCount) || keepCount < 1) throw new Error(`invalid retention count: ${keepArgument ?? ''}`);
  if (!rootArgument) throw new Error('transcript root is required');

  const root = resolve(rootArgument);
  const excluded = agent === 'claude'
    ? new Set(['subagents', 'tool-results', 'workflows'])
    : new Set(['tasks']);
  const parser = agent === 'claude' ? parseClaudeTimestamp : parsePiTimestamp;
  retainLatest(agent, discoverTranscripts(root, excluded), keepCount, parser);
}

main();
