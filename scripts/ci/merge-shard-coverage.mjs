#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_REPORT_BYTES = 25 * 1024 * 1024;
const MAX_REPORTS = 32;
const METRICS = ['statements', 'branches', 'functions', 'lines'];

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/.test(value ?? '')) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateHits(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

function validateLocation(value, label) {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) throw new Error(`${label} must be a source location`);
  for (const [name, position] of [['start', value.start], ['end', value.end]]) {
    if (!Number.isSafeInteger(position.line) || position.line < 0 || !Number.isSafeInteger(position.column) || position.column < 0) {
      throw new Error(`${label} ${name} position is invalid`);
    }
  }
}

function validateCoverageRecord(source, coverage) {
  if (!source || /[\r\n]/.test(source) || !isRecord(coverage) || coverage.path !== source) {
    throw new Error(`invalid coverage record: ${source}`);
  }
  for (const [mapName, counterName, label] of [
    ['statementMap', 's', 'statement'],
    ['fnMap', 'f', 'function'],
    ['branchMap', 'b', 'branch'],
  ]) {
    const map = coverage[mapName];
    const counters = coverage[counterName];
    if (!isRecord(map) || !isRecord(counters)) throw new Error(`${source} ${label} map and counters must be objects`);
    const mapKeys = Object.keys(map).sort();
    const counterKeys = Object.keys(counters).sort();
    if (JSON.stringify(mapKeys) !== JSON.stringify(counterKeys)) throw new Error(`${source} ${label} map and counter keys differ`);
    for (const key of mapKeys) {
      if (!isRecord(map[key])) throw new Error(`${source} ${label} map ${key} must be an object`);
      if (label === 'statement') {
        validateLocation(map[key], `${source} statement map ${key}`);
        if (map[key].start.line < 1) throw new Error(`${source} statement map ${key} must start on a positive line`);
      }
      if (label === 'function') {
        validateLocation(map[key].decl, `${source} function declaration ${key}`);
        validateLocation(map[key].loc, `${source} function location ${key}`);
      }
      if (label === 'branch') {
        if (!Array.isArray(map[key].locations) || map[key].locations.length < 1) throw new Error(`${source} branch map ${key} must have locations`);
        map[key].locations.forEach((location, index) => validateLocation(location, `${source} branch location ${key}[${index}]`));
        if (!Array.isArray(counters[key]) || counters[key].length !== map[key].locations.length) throw new Error(`${source} branch counter ${key} must match its locations`);
        counters[key].forEach((hits, index) => validateHits(hits, `${source} branch counter ${key}[${index}]`));
      } else {
        validateHits(counters[key], `${source} ${label} counter ${key}`);
      }
    }
  }
}

function addCounts(target, source, label) {
  const targetKeys = Object.keys(target).sort();
  const sourceKeys = Object.keys(source).sort();
  if (JSON.stringify(targetKeys) !== JSON.stringify(sourceKeys)) throw new Error(`${label} counter shape differs between shards`);
  for (const key of targetKeys) {
    if (Array.isArray(target[key])) {
      if (!Array.isArray(source[key]) || target[key].length !== source[key].length) {
        throw new Error(`${label} branch shape differs between shards`);
      }
      target[key] = target[key].map((value, index) => value + source[key][index]);
    } else {
      target[key] += source[key];
    }
  }
}

function mergeFileCoverage(target, source) {
  for (const map of ['statementMap', 'fnMap', 'branchMap']) {
    if (JSON.stringify(target[map]) !== JSON.stringify(source[map])) {
      throw new Error(`${map} differs between shards for ${target.path}`);
    }
  }
  addCounts(target.s, source.s, `${target.path} statement`);
  addCounts(target.f, source.f, `${target.path} function`);
  addCounts(target.b, source.b, `${target.path} branch`);
}

function metric(covered, total) {
  return { covered, total, pct: total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100 };
}

function summarize(files) {
  let statements = metric(0, 0);
  let branches = metric(0, 0);
  let functions = metric(0, 0);
  const lines = new Map();
  for (const file of files.values()) {
    const statementHits = Object.values(file.s);
    statements = metric(statements.covered + statementHits.filter((hits) => hits > 0).length, statements.total + statementHits.length);
    const functionHits = Object.values(file.f);
    functions = metric(functions.covered + functionHits.filter((hits) => hits > 0).length, functions.total + functionHits.length);
    const branchHits = Object.values(file.b).flat();
    branches = metric(branches.covered + branchHits.filter((hits) => hits > 0).length, branches.total + branchHits.length);
    for (const [key, hits] of Object.entries(file.s)) {
      const line = file.statementMap[key].start.line;
      const id = `${file.path}:${line}`;
      lines.set(id, Math.max(lines.get(id) ?? 0, hits));
    }
  }
  return {
    statements,
    branches,
    functions,
    lines: metric([...lines.values()].filter((hits) => hits > 0).length, lines.size),
  };
}

function writeLcov(output, files) {
  const records = [];
  for (const file of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const lines = new Map();
    for (const [key, hits] of Object.entries(file.s)) {
      const line = file.statementMap[key].start.line;
      lines.set(line, Math.max(lines.get(line) ?? 0, hits));
    }
    records.push('TN:', `SF:${file.path}`);
    for (const [line, hits] of [...lines.entries()].sort((a, b) => a[0] - b[0])) records.push(`DA:${line},${hits}`);
    records.push(`LF:${lines.size}`, `LH:${[...lines.values()].filter((hits) => hits > 0).length}`, 'end_of_record');
  }
  writeFileSync(join(output, 'lcov.info'), `${records.join('\n')}\n`);
}

export function mergeShardCoverage({ artifactRoot, outputDir, expectedReports, expectedPrefix, thresholds }) {
  const root = resolve(artifactRoot);
  const output = resolve(outputDir);
  const reportPaths = readdirSync(root, { recursive: true })
    .map(String)
    .filter((path) => path.endsWith('coverage-final.json'))
    .sort();
  if (reportPaths.length !== expectedReports) {
    throw new Error(`expected ${expectedReports} shard coverage reports, found ${reportPaths.length}`);
  }
  if (reportPaths.length > MAX_REPORTS) throw new Error(`coverage report count exceeds ${MAX_REPORTS}`);
  const identities = new Map();
  for (const relativePath of reportPaths) {
    const identity = relativePath.split(/[\\/]/, 1)[0];
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
  }
  const identityErrors = [];
  for (let index = 1; index <= expectedReports; index += 1) {
    const identity = `${expectedPrefix}-${index}`;
    const count = identities.get(identity) ?? 0;
    if (count !== 1) identityErrors.push(`expected exactly one coverage report for ${identity}, found ${count}`);
    identities.delete(identity);
  }
  for (const [identity, count] of identities) identityErrors.push(`unexpected coverage artifact ${identity} contains ${count} report(s)`);
  if (identityErrors.length > 0) throw new Error(identityErrors.join('; '));

  const files = new Map();
  for (const relativePath of reportPaths) {
    const path = join(root, relativePath);
    if (statSync(path).size > MAX_REPORT_BYTES) throw new Error(`coverage report exceeds ${MAX_REPORT_BYTES} bytes: ${relativePath}`);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(report)) throw new Error(`coverage report must be an object: ${relativePath}`);
    for (const [source, coverage] of Object.entries(report)) {
      validateCoverageRecord(source, coverage);
      const existing = files.get(source);
      if (existing) mergeFileCoverage(existing, coverage);
      else files.set(source, structuredClone(coverage));
    }
  }
  if (files.size === 0) throw new Error('merged coverage contains no source files');

  const summary = summarize(files);
  const misses = METRICS.flatMap((name) => summary[name].pct < thresholds[name]
    ? [`Coverage for ${name} (${summary[name].pct}%) does not meet global threshold (${thresholds[name]}%)`]
    : []);

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeLcov(output, files);
  process.stdout.write('All files | % Stmts | % Branch | % Funcs | % Lines |\n');
  process.stdout.write(`All files | ${summary.statements.pct} | ${summary.branches.pct} | ${summary.functions.pct} | ${summary.lines.pct} |\n`);
  process.stdout.write(`Merged ${reportPaths.length} shard coverage reports.\n`);
  for (const miss of misses) process.stderr.write(`ERROR: ${miss}\n`);
  return misses.length === 0;
}

function main() {
  const [artifactRoot, outputDir, rawExpected, expectedPrefix, ...rawThresholds] = process.argv.slice(2);
  if (!artifactRoot || !outputDir || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(expectedPrefix ?? '') || rawThresholds.length !== METRICS.length) {
    throw new Error('Usage: merge-shard-coverage.mjs <artifact-root> <output-dir> <expected-reports> <artifact-prefix> <statements> <branches> <functions> <lines>');
  }
  const expectedReports = parseInteger(rawExpected, 'expected reports', 1, MAX_REPORTS);
  const thresholds = Object.fromEntries(METRICS.map((name, index) => [
    name,
    parseInteger(rawThresholds[index], `${name} threshold`, 0, 100),
  ]));
  if (!mergeShardCoverage({ artifactRoot, outputDir, expectedReports, expectedPrefix, thresholds })) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
