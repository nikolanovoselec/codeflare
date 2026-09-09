#!/usr/bin/env node
/**
 * Deterministic, phase-oriented compaction for Vault/Raw/Sessions.
 *
 * prepare publishes Archive.md and an exact manifest while retaining sources;
 * verify validates a downloaded archive or shell-reported remote digest and
 * explicit conflict evidence; delete revalidates all local bytes before
 * removing only the manifest-recorded source paths. Sync orchestration stays
 * with entrypoint.sh.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIVE_FILENAME = 'Archive.md';
export const ARCHIVE_HEADER = Buffer.from(
  '# Archived session captures\n\n'
  + 'This file is managed by Codeflare. Entry metadata and byte lengths make the embedded source bytes independently verifiable.\n\n'
  + '<!-- codeflare-session-archive:v1 -->\n',
);
const ENTRY_METADATA_PREFIX = Buffer.from('<!-- capture-metadata:');
const ENTRY_METADATA_SUFFIX = Buffer.from(' -->\n');
// Capture timestamps are classified by shape only. Their offset/Z text is not
// converted to an instant because retention intentionally uses only the
// leading calendar day. These are the four capture shapes emitted over time:
// naïve, Z, millisecond-Z, and a compact numeric offset.
const CAPTURE_NAME = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3])-[0-5]\d-[0-5]\d(?:\.\d{3}Z|Z|[+-](?:(?:0\d|1[0-3])[0-5]\d|1400))?-[A-Za-z0-9][A-Za-z0-9_-]*\.md$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MANIFEST_VERSION = 1;
const PREPARED_STATE = 'archive-prepared-sources-present';

function sourceLocation(filename) {
  return `archive:${filename}`;
}

function heading(filename) {
  return Buffer.from(`## ${filename}\n\n`);
}

function beginMarker(filename) {
  return Buffer.from(`<!-- capture-begin:${sourceLocation(filename)} -->\n`);
}

function endMarker(filename) {
  return Buffer.from(`\n<!-- capture-end:${sourceLocation(filename)} -->\n\n`);
}

export class CompactionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompactionError';
  }
}

function fail(message) {
  throw new CompactionError(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCapture(left, right) {
  return compareText(left.date, right.date) || compareText(left.filename, right.filename);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function renderManifest(manifest) {
  return Buffer.from(`${JSON.stringify(stableValue(manifest), null, 2)}\n`);
}

function parseCalendarDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must be YYYY-MM-DD`);
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    fail(`${label} is not a calendar date: ${value}`);
  }
  return value;
}

function captureDay(filename) {
  if (filename === ARCHIVE_FILENAME) return null;
  const match = CAPTURE_NAME.exec(filename);
  if (!match) return null;
  try {
    return parseCalendarDay(match[1], `capture date for ${filename}`);
  } catch (error) {
    if (error instanceof CompactionError) return null;
    throw error;
  }
}

export function utcMonthEarlierDay(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(`${parseCalendarDay(now, 'today')}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) fail('now is not a valid date');
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const day = instant.getUTCDate();
  const lastDayOfPriorMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDayOfPriorMonth))).toISOString().slice(0, 10);
}

function readDirectRegularFile(path, label) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(descriptor).isFile()) fail(`${label} is not a direct regular file: ${path}`);
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof CompactionError) throw error;
    fail(`${label} is not a readable direct regular file: ${path}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    try {
      const directory = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      // Some filesystems reject directory fsync; the file payload is already durable.
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function metadataOf(capture) {
  return {
    bytes: capture.bytes,
    date: capture.date,
    filename: capture.filename,
    sha256: capture.sha256,
  };
}

function validateMetadata(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort(compareText).join(',') !== 'bytes,date,filename,sha256') {
    fail(`${label} metadata is malformed`);
  }
  if (typeof value.filename !== 'string' || basename(value.filename) !== value.filename
      || !value.filename || value.filename === ARCHIVE_FILENAME) {
    fail(`${label} filename is malformed`);
  }
  const date = captureDay(value.filename);
  if (!date || parseCalendarDay(value.date, `${label} date`) !== date) {
    fail(`${label} date does not match filename: ${value.filename}`);
  }
  if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    fail(`${label} sha256 is malformed: ${value.filename}`);
  }
  if (!isNonNegativeInteger(value.bytes)) {
    fail(`${label} byte length is malformed: ${value.filename}`);
  }
  return { filename: value.filename, date, sha256: value.sha256, bytes: value.bytes };
}

export function buildSessionArchive(captures) {
  const ordered = [...captures].sort(compareCapture);
  const chunks = [ARCHIVE_HEADER];
  for (const capture of ordered) {
    chunks.push(
      heading(capture.filename),
      beginMarker(capture.filename),
      ENTRY_METADATA_PREFIX,
      Buffer.from(canonicalJson(metadataOf(capture))),
      ENTRY_METADATA_SUFFIX,
      capture.content,
      endMarker(capture.filename),
    );
  }
  return Buffer.concat(chunks);
}

export function parseSessionArchive(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.subarray(0, ARCHIVE_HEADER.length).compare(ARCHIVE_HEADER) !== 0) {
    fail('malformed archive: missing exact Codeflare v1 header');
  }
  const captures = [];
  const seen = new Set();
  let offset = ARCHIVE_HEADER.length;
  while (offset < bytes.length) {
    if (bytes.subarray(offset, offset + 3).toString('ascii') !== '## ') {
      fail(`malformed archive: expected capture heading at byte ${offset}`);
    }
    const headingEnd = bytes.indexOf(Buffer.from('\n\n'), offset + 3);
    if (headingEnd < 0) fail('malformed archive: unterminated capture heading');
    const filename = bytes.subarray(offset + 3, headingEnd).toString('ascii');
    if (!captureDay(filename)) fail(`malformed archive: invalid capture heading: ${filename}`);
    offset = headingEnd + 2;

    const expectedBegin = beginMarker(filename);
    if (bytes.subarray(offset, offset + expectedBegin.length).compare(expectedBegin) !== 0) {
      fail(`malformed archive: bad capture-begin marker for ${filename}`);
    }
    offset += expectedBegin.length;
    if (bytes.subarray(offset, offset + ENTRY_METADATA_PREFIX.length).compare(ENTRY_METADATA_PREFIX) !== 0) {
      fail(`malformed archive: missing metadata for ${filename}`);
    }
    const metadataStart = offset + ENTRY_METADATA_PREFIX.length;
    const metadataEnd = bytes.indexOf(ENTRY_METADATA_SUFFIX, metadataStart);
    if (metadataEnd < 0) fail('malformed archive: unterminated entry metadata');
    const metadataBytes = bytes.subarray(metadataStart, metadataEnd);
    let metadata;
    try {
      metadata = JSON.parse(metadataBytes.toString('ascii'));
    } catch {
      fail('malformed archive: invalid entry metadata JSON');
    }
    if (canonicalJson(metadata) !== metadataBytes.toString('ascii')) {
      fail('malformed archive: entry metadata is not canonical');
    }
    const capture = validateMetadata(metadata, 'archive entry');
    if (capture.filename !== filename) fail(`malformed archive: heading does not match metadata: ${filename}`);
    if (seen.has(capture.filename)) fail(`duplicate archive entry: ${capture.filename}`);
    seen.add(capture.filename);
    const contentStart = metadataEnd + ENTRY_METADATA_SUFFIX.length;
    const contentEnd = contentStart + capture.bytes;
    if (contentEnd > bytes.length) fail(`malformed archive: truncated content for ${capture.filename}`);
    capture.content = Buffer.from(bytes.subarray(contentStart, contentEnd));
    const expectedEnd = endMarker(filename);
    if (bytes.subarray(contentEnd, contentEnd + expectedEnd.length).compare(expectedEnd) !== 0) {
      fail(`malformed archive: bad capture-end marker for ${capture.filename}`);
    }
    if (sha256(capture.content) !== capture.sha256) {
      fail(`malformed archive: sha256 mismatch for ${capture.filename}`);
    }
    captures.push(capture);
    offset = contentEnd + expectedEnd.length;
  }
  const ordered = [...captures].sort(compareCapture);
  if (captures.some((capture, index) => compareCapture(capture, ordered[index]) !== 0)) {
    fail('malformed archive: entries are not ordered by date then filename');
  }
  if (!buildSessionArchive(captures).equals(bytes)) {
    fail('malformed archive: bytes are not in canonical form');
  }
  return captures;
}

function readExistingArchive(path) {
  try {
    if (!lstatSync(path).isFile()) fail(`archive must be a direct regular file: ${path}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return { bytes: null, captures: [] };
    throw error;
  }
  const bytes = readDirectRegularFile(path, 'archive');
  return { bytes, captures: parseSessionArchive(bytes) };
}

export function selectColdCaptures(sessionsDir, cutoffDate = utcMonthEarlierDay()) {
  const cutoff = parseCalendarDay(cutoffDate, 'cutoff date');
  const captures = [];
  let entries;
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch (error) {
    fail(`cannot read sessions directory ${sessionsDir}: ${error.message}`);
  }
  for (const entry of entries) {
    const date = captureDay(entry.name);
    if (!date || date >= cutoff || !entry.isFile()) continue;
    const content = readDirectRegularFile(join(sessionsDir, entry.name), 'capture candidate');
    captures.push({
      filename: entry.name,
      date,
      sha256: sha256(content),
      bytes: content.length,
      content,
    });
  }
  return captures.sort(compareCapture);
}

function manifestSource(capture, sessionsDir) {
  const source_location = sourceLocation(capture.filename);
  return {
    ...metadataOf(capture),
    archive_marker: beginMarker(capture.filename).toString('ascii').trimEnd(),
    source_file: join(sessionsDir, capture.filename),
    source_location,
  };
}

function makeManifest(archive, archivePath, cutoffDate, captures, sessionsDir) {
  return {
    archive: { bytes: archive.length, filename: ARCHIVE_FILENAME, sha256: sha256(archive) },
    archive_file: archivePath,
    cutoff_date: cutoffDate,
    deletion_sync_completed: false,
    phase_state: PREPARED_STATE,
    sources: captures.map((capture) => manifestSource(capture, sessionsDir)),
    version: MANIFEST_VERSION,
  };
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort(compareText).join(',') !== 'archive,archive_file,cutoff_date,deletion_sync_completed,phase_state,sources,version') {
    fail('manifest has an unexpected or missing field');
  }
  if (value.version !== MANIFEST_VERSION) fail('manifest version is unsupported');
  if (value.phase_state !== PREPARED_STATE || value.deletion_sync_completed !== false) {
    fail('manifest phase state is unsupported');
  }
  if (typeof value.archive_file !== 'string' || basename(value.archive_file) !== ARCHIVE_FILENAME) {
    fail('manifest archive_file must resolve to Archive.md');
  }
  const cutoff = parseCalendarDay(value.cutoff_date, 'manifest cutoff_date');
  if (!value.archive || typeof value.archive !== 'object' || Array.isArray(value.archive)
      || Object.keys(value.archive).sort(compareText).join(',') !== 'bytes,filename,sha256'
      || value.archive.filename !== ARCHIVE_FILENAME
      || !isNonNegativeInteger(value.archive.bytes)
      || typeof value.archive.sha256 !== 'string' || !SHA256.test(value.archive.sha256)) {
    fail('manifest archive metadata is malformed');
  }
  if (!Array.isArray(value.sources)) fail('manifest sources must be a list');
  const seen = new Set();
  const sources = value.sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || Object.keys(source).sort(compareText).join(',') !== 'archive_marker,bytes,date,filename,sha256,source_file,source_location') {
      fail('manifest source metadata is malformed');
    }
    const validated = validateMetadata({
      bytes: source.bytes,
      date: source.date,
      filename: source.filename,
      sha256: source.sha256,
    }, 'manifest source');
    if (source.source_file !== join(dirname(value.archive_file), validated.filename)) {
      fail(`manifest source_file does not match archive directory: ${validated.filename}`);
    }
    if (source.source_location !== sourceLocation(validated.filename)
        || source.archive_marker !== beginMarker(validated.filename).toString('ascii').trimEnd()) {
      fail(`manifest archive marker is malformed: ${validated.filename}`);
    }
    if (validated.date >= cutoff) fail(`manifest source is inside the retention window: ${validated.filename}`);
    if (seen.has(validated.filename)) fail(`manifest source is duplicated: ${validated.filename}`);
    seen.add(validated.filename);
    return validated;
  });
  const ordered = [...sources].sort(compareCapture);
  if (sources.some((source, index) => compareCapture(source, ordered[index]) !== 0)) {
    fail('manifest sources are not ordered by date then filename');
  }
  return value;
}

function loadManifest(path) {
  const bytes = readDirectRegularFile(path, 'manifest');
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('manifest is not valid JSON');
  }
  const manifest = validateManifest(value);
  if (!renderManifest(manifest).equals(bytes)) {
    fail('manifest does not match its exact canonical representation');
  }
  return manifest;
}

function verifyArchiveBytes(manifest, bytes) {
  if (bytes.length !== manifest.archive.bytes) {
    fail(`archive byte length mismatch: expected ${manifest.archive.bytes}, got ${bytes.length}`);
  }
  const digest = sha256(bytes);
  if (digest !== manifest.archive.sha256) {
    fail(`archive sha256 mismatch: expected ${manifest.archive.sha256}, got ${digest}`);
  }
  const archived = new Map(parseSessionArchive(bytes).map((capture) => [capture.filename, capture]));
  for (const source of manifest.sources) {
    const capture = archived.get(source.filename);
    if (!capture) fail(`archive lacks manifest source: ${source.filename}`);
    if (canonicalJson(metadataOf(capture)) !== canonicalJson(metadataOf(source))) {
      fail(`archive entry conflicts with manifest source: ${source.filename}`);
    }
  }
}

function sameCapture(left, right) {
  return left.filename === right.filename
    && canonicalJson(metadataOf(left)) === canonicalJson(metadataOf(right))
    && left.content.equals(right.content);
}

function revalidatePrepareInputs({ sessionsDir, cutoffDate, archivePath, existing, cold }) {
  const currentArchive = readExistingArchive(archivePath);
  if ((existing.bytes === null) !== (currentArchive.bytes === null)
      || (existing.bytes !== null && !existing.bytes.equals(currentArchive.bytes))) {
    fail('archive changed during prepare; refusing to publish');
  }
  const currentCold = selectColdCaptures(sessionsDir, cutoffDate);
  if (cold.length !== currentCold.length
      || cold.some((capture, index) => !sameCapture(capture, currentCold[index]))) {
    fail('capture source changed during prepare; refusing to publish');
  }
}

export function prepareArchive({
  sessionsDir,
  manifestPath,
  today = new Date(),
  beforeRevalidate = () => {},
}) {
  const cutoffDate = utcMonthEarlierDay(today);
  const archivePath = join(sessionsDir, ARCHIVE_FILENAME);
  const existing = readExistingArchive(archivePath);
  const cold = selectColdCaptures(sessionsDir, cutoffDate);
  const archived = new Map(existing.captures.map((capture) => [capture.filename, capture]));
  const merged = new Map(archived);
  for (const capture of cold) {
    const prior = archived.get(capture.filename);
    if (prior && (!prior.content.equals(capture.content)
      || canonicalJson(metadataOf(prior)) !== canonicalJson(metadataOf(capture)))) {
      fail(`capture conflicts with archived entry: ${capture.filename}`);
    }
    merged.set(capture.filename, capture);
  }
  if (cold.length === 0) {
    return {
      phase: 'prepare',
      phase_state: 'no-cold-sources',
      status: 'noop',
      cutoff_date: cutoffDate,
      deletion_sync_completed: false,
      next_phase: null,
      source_count: 0,
    };
  }
  const archive = buildSessionArchive([...merged.values()]);
  const manifest = makeManifest(archive, archivePath, cutoffDate, cold, sessionsDir);
  beforeRevalidate();
  // Re-read the complete selected set and the exact prior archive immediately
  // before the first replacement. Any drift aborts before Archive.md or the
  // manifest is written.
  revalidatePrepareInputs({ sessionsDir, cutoffDate, archivePath, existing, cold });
  if (!existing.bytes?.equals(archive)) atomicWrite(archivePath, archive);
  atomicWrite(manifestPath, renderManifest(manifest));
  return {
    phase: 'prepare',
    phase_state: PREPARED_STATE,
    status: 'prepared',
    archive: archivePath,
    archive_sha256: manifest.archive.sha256,
    archive_bytes: manifest.archive.bytes,
    cutoff_date: cutoffDate,
    deletion_sync_completed: false,
    next_phase: 'delete-sources',
    source_count: cold.length,
  };
}

export function deleteVerifiedSources({ sessionsDir, manifestPath }) {
  const manifest = loadManifest(manifestPath);
  const archive = readDirectRegularFile(join(sessionsDir, ARCHIVE_FILENAME), 'local archive');
  verifyArchiveBytes(manifest, archive);
  const current = selectColdCaptures(sessionsDir, manifest.cutoff_date);
  if (current.map(({ filename }) => filename).join('\0') !== manifest.sources.map(({ filename }) => filename).join('\0')) {
    fail('current compaction candidate set does not exactly match the manifest');
  }
  for (let index = 0; index < current.length; index += 1) {
    if (canonicalJson(metadataOf(current[index])) !== canonicalJson(metadataOf(manifest.sources[index]))) {
      fail(`source no longer exactly matches the manifest: ${current[index].filename}`);
    }
  }
  // Re-read every source before the first unlink. No glob or age-based deletion
  // occurs: only these exact manifest paths are removed.
  for (const source of manifest.sources) {
    const bytes = readDirectRegularFile(join(sessionsDir, source.filename), 'source revalidation');
    if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256) {
      fail(`source changed during delete revalidation: ${source.filename}`);
    }
  }
  for (const source of manifest.sources) unlinkSync(join(sessionsDir, source.filename));
  return {
    phase: 'delete',
    phase_state: 'sources-deleted-locally',
    deleted: manifest.sources.map(({ filename }) => filename),
    deleted_count: manifest.sources.length,
    sync_required: true,
  };
}

function parseOptions(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    if (index + 1 >= argv.length) fail(`missing value for ${value}`);
    if (options.has(value)) fail(`duplicate option: ${value}`);
    options.set(value, argv[++index]);
  }
  return { positional, options };
}

function requireOptions(options, allowed) {
  for (const option of options.keys()) {
    if (!allowed.has(option)) fail(`unknown option: ${option}`);
  }
}

function usage() {
  return 'usage:\n'
    + '  compact-session-captures.mjs prepare SESSIONS_DIR MANIFEST [--today YYYY-MM-DD]\n'
    + '  compact-session-captures.mjs delete SESSIONS_DIR MANIFEST\n';
}

export function main(argv = process.argv.slice(2)) {
  const [phase, ...rest] = argv;
  const { positional, options } = parseOptions(rest);
  if (phase === 'prepare' && positional.length === 2) {
    requireOptions(options, new Set(['--today']));
    return prepareArchive({ sessionsDir: positional[0], manifestPath: positional[1], today: options.get('--today') ?? new Date() });
  }
  if (phase === 'delete' && positional.length === 2 && options.size === 0) {
    return deleteVerifiedSources({ sessionsDir: positional[0], manifestPath: positional[1] });
  }
  fail(usage().trimEnd());
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(`${canonicalJson(main())}\n`);
  } catch (error) {
    if (!(error instanceof CompactionError)) throw error;
    process.stderr.write(`compact-session-captures: ${error.message}\n`);
    process.exitCode = 1;
  }
}
