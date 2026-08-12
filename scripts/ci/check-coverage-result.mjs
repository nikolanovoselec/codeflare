#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COVERAGE_TABLE = /^\s*All files\s*\|/m;
const FAILED_TESTS = /^ *Tests +.*failed/m;
const THRESHOLD_MISS = /does not meet .*threshold/;
const PASSED_TEST_FILES = /^ *Test Files +(?=[^\n]*\bpassed\b)(?![^\n]*\bfailed\b)[^\n]*\(\d+\)\s*$/m;
const PASSED_TESTS = /^ *Tests +(?=[^\n]*\bpassed\b)(?![^\n]*\bfailed\b)[^\n]*\(\d+\)\s*$/m;
const MULTIPLE_ERRORS = /^ *Errors +(?:[2-9]|\d{2,}) errors?\b/m;
const POOL_CRASH = '[vitest-pool]: Worker cloudflare-pool emitted error.';

export const CHANGED_COVERAGE_LIMITS = Object.freeze({
  maxDiffBytes: 10 * 1024 * 1024,
  maxLcovBytes: 25 * 1024 * 1024,
  maxChangedFiles: 500,
  maxChangedLines: 10_000,
});

export function evaluateCoverageResult(log, status, toleratePoolCrash) {
  if (!COVERAGE_TABLE.test(log)) {
    return { ok: false, message: 'no coverage table was produced — thresholds were never evaluated' };
  }
  if (FAILED_TESTS.test(log)) {
    return { ok: false, message: 'tests failed during the coverage run' };
  }
  if (THRESHOLD_MISS.test(log)) {
    return { ok: false, message: 'coverage thresholds not met (see the table above)' };
  }
  if (status !== 0) {
    if (toleratePoolCrash && log.includes(POOL_CRASH)) {
      if (!PASSED_TEST_FILES.test(log) || !PASSED_TESTS.test(log) || MULTIPLE_ERRORS.test(log)) {
        return {
          ok: false,
          message: 'coverage run did not isolate the teardown crash after a complete passing test summary',
          status,
        };
      }
      return { ok: true, warning: 'tolerating the known workerd teardown crash after a complete passing test summary and verified coverage table' };
    }
    return { ok: false, message: `coverage run failed with status ${status}`, status };
  }
  return { ok: true };
}

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isProductionPath(path, packageRoot) {
  const normalized = normalizePath(path);
  const root = normalizePath(packageRoot).replace(/\/$/, '');
  const prefix = root === '.' ? 'src/' : `${root}/src/`;
  if (!normalized.startsWith(prefix)) return false;
  if (!/\.(?:ts|tsx)$/.test(normalized)) return false;
  if (normalized.includes('/__tests__/') || normalized.endsWith('.test.ts') || normalized.endsWith('.test.tsx')) return false;
  if (normalized.endsWith('.generated.ts') || normalized.endsWith('.d.ts')) return false;
  if (root === 'web-ui' && normalized === 'web-ui/src/index.tsx') return false;
  return true;
}

function parseChangedProduction(diff, packageRoot, limits) {
  const files = new Set();
  const linesByFile = new Map();
  let currentPath = null;
  let changedLineCount = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      currentPath = raw === '/dev/null' ? null : normalizePath(raw.replace(/^b\//, ''));
      if (currentPath && isProductionPath(currentPath, packageRoot)) {
        files.add(currentPath);
        if (files.size > limits.maxChangedFiles) {
          throw new Error(`changed production file count exceeds ${limits.maxChangedFiles}`);
        }
        if (!linesByFile.has(currentPath)) linesByFile.set(currentPath, new Set());
      } else {
        currentPath = null;
      }
      continue;
    }
    if (!currentPath || !line.startsWith('@@ ')) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) throw new Error(`malformed unified-diff hunk: ${line}`);
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`invalid unified-diff hunk range: ${line}`);
    }
    const changed = linesByFile.get(currentPath);
    for (let offset = 0; offset < count; offset += 1) {
      changed.add(start + offset);
      changedLineCount += 1;
      if (changedLineCount > limits.maxChangedLines) {
        throw new Error(`changed production line count exceeds ${limits.maxChangedLines}`);
      }
    }
  }

  return { files, linesByFile };
}

function normalizeLcovSource(source, packageRoot, repoRoot) {
  const normalizedRoot = normalizePath(packageRoot).replace(/\/$/, '');
  if (isAbsolute(source)) {
    if (repoRoot) return normalizePath(relative(repoRoot, source));
    const marker = normalizedRoot === '.' ? '/src/' : `/${normalizedRoot}/src/`;
    const index = normalizePath(source).lastIndexOf(marker);
    return index >= 0 ? normalizePath(source).slice(index + 1) : normalizePath(source);
  }
  const normalized = normalizePath(source);
  if (normalizedRoot === '.' || normalized.startsWith(`${normalizedRoot}/`)) return normalized;
  return `${normalizedRoot}/${normalized}`;
}

function parseLcov(lcov, packageRoot, repoRoot) {
  const records = new Map();
  let currentPath = null;
  let currentLines = null;

  for (const rawLine of lcov.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('SF:')) {
      if (currentPath !== null) throw new Error('LCOV record started before the prior end_of_record');
      const source = line.slice(3);
      if (!source) throw new Error('LCOV SF record has no path');
      currentPath = normalizeLcovSource(source, packageRoot, repoRoot);
      currentLines = new Map();
      continue;
    }
    if (line.startsWith('DA:')) {
      if (currentPath === null || currentLines === null) throw new Error('LCOV DA record appears outside an SF record');
      const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line);
      if (!match) throw new Error(`malformed LCOV DA record: ${line}`);
      const lineNumber = Number(match[1]);
      const hits = Number(match[2]);
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(hits) || hits < 0) {
        throw new Error(`invalid LCOV DA record: ${line}`);
      }
      currentLines.set(lineNumber, (currentLines.get(lineNumber) ?? 0) + hits);
      continue;
    }
    if (line === 'end_of_record') {
      if (currentPath === null || currentLines === null) throw new Error('LCOV end_of_record has no SF record');
      const existing = records.get(currentPath) ?? new Map();
      for (const [lineNumber, hits] of currentLines) {
        existing.set(lineNumber, (existing.get(lineNumber) ?? 0) + hits);
      }
      records.set(currentPath, existing);
      currentPath = null;
      currentLines = null;
    }
  }

  if (currentPath !== null) throw new Error('LCOV record is missing end_of_record');
  if (records.size === 0) throw new Error('LCOV contains no source records');
  return records;
}

export function evaluateChangedLineCoverage({
  diff,
  lcov,
  packageRoot,
  threshold,
  repoRoot,
  maxDiffBytes = CHANGED_COVERAGE_LIMITS.maxDiffBytes,
  maxLcovBytes = CHANGED_COVERAGE_LIMITS.maxLcovBytes,
  maxChangedFiles = CHANGED_COVERAGE_LIMITS.maxChangedFiles,
  maxChangedLines = CHANGED_COVERAGE_LIMITS.maxChangedLines,
}) {
  if (!['.', 'web-ui'].includes(packageRoot)) {
    return { ok: false, message: `unsupported coverage package root: ${packageRoot}` };
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold >= 100) {
    return { ok: false, message: 'changed-line threshold must be a number from 0 up to (but not including) 100' };
  }
  if (Buffer.byteLength(diff, 'utf8') > maxDiffBytes) {
    return { ok: false, message: `changed-line diff exceeds the ${maxDiffBytes}-byte bound` };
  }

  let changed;
  try {
    changed = parseChangedProduction(diff, packageRoot, { maxChangedFiles, maxChangedLines });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const files = [...changed.files].sort();
  if (files.length === 0) {
    return { ok: true, message: 'no changed production files require LCOV evidence', files, covered: 0, total: 0, percentage: 100 };
  }
  if (lcov === null || lcov === undefined || lcov === '') {
    return { ok: false, message: 'changed production files require an LCOV report', files };
  }
  if (Buffer.byteLength(lcov, 'utf8') > maxLcovBytes) {
    return { ok: false, message: `LCOV report exceeds the ${maxLcovBytes}-byte bound`, files };
  }

  let records;
  try {
    records = parseLcov(lcov, packageRoot, repoRoot);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), files };
  }
  const missing = files.filter((file) => !records.has(file));
  if (missing.length > 0) {
    return { ok: false, message: `LCOV has no record for changed production file(s): ${missing.join(', ')}`, files };
  }

  let covered = 0;
  let total = 0;
  for (const file of files) {
    const changedLines = changed.linesByFile.get(file) ?? new Set();
    const coverageLines = records.get(file);
    for (const lineNumber of changedLines) {
      if (!coverageLines.has(lineNumber)) continue;
      total += 1;
      if (coverageLines.get(lineNumber) > 0) covered += 1;
    }
  }
  const percentage = total === 0 ? 100 : Math.round((covered / total) * 10_000) / 100;
  if (percentage < threshold) {
    return {
      ok: false,
      message: `changed production line coverage ${percentage}% is below the ${threshold}% package floor (${covered}/${total})`,
      files,
      covered,
      total,
      percentage,
    };
  }
  return {
    ok: true,
    message: `changed production line coverage ${percentage}% meets the ${threshold}% package floor (${covered}/${total})`,
    files,
    covered,
    total,
    percentage,
  };
}

function changedCoverageFromGit(lcovPath, changedBase, packageRoot, threshold) {
  if (!/^[0-9a-f]{40}$/i.test(changedBase)) {
    return { ok: false, message: 'changed-line base must be a full 40-character commit SHA' };
  }
  const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (rootResult.status !== 0) return { ok: false, message: 'unable to resolve the repository root for changed-line coverage' };
  const repoRoot = rootResult.stdout.trim();
  // Ask git only for the tree the evaluator can act on: isProductionPath accepts nothing
  // outside <root>/src. Diffing the whole repository buffered every generated artifact in
  // the range as well, and a refreshed graph export alone carried the range past the
  // 10 MB bound -- the job then died with ENOBUFS over a commit that touched no source.
  // `:(top)` anchors the pathspec at the repository root. The checker runs with cwd set to
  // the package directory, so a plain `web-ui/src` would resolve to `web-ui/web-ui/src`,
  // match nothing, and hand the evaluator an empty diff -- which reads as "no changed
  // production lines" and passes the package unconditionally.
  const sourcePathspec = `:(top)${packageRoot === '.' ? 'src' : `${packageRoot}/src`}`;
  const diffResult = spawnSync(
    'git',
    ['diff', '--unified=0', '--find-renames', '--diff-filter=ACMRT', `${changedBase}^{tree}`, 'HEAD^{tree}', '--', sourcePathspec],
    { encoding: 'utf8', maxBuffer: CHANGED_COVERAGE_LIMITS.maxDiffBytes + 1 },
  );
  if (diffResult.status !== 0 || diffResult.error) {
    return { ok: false, message: `unable to read the pull-request diff: ${diffResult.stderr || diffResult.error?.message || 'git diff failed'}` };
  }

  let lcov = null;
  if (existsSync(lcovPath)) {
    if (statSync(lcovPath).size > CHANGED_COVERAGE_LIMITS.maxLcovBytes) {
      return { ok: false, message: `LCOV report exceeds the ${CHANGED_COVERAGE_LIMITS.maxLcovBytes}-byte bound` };
    }
    lcov = readFileSync(lcovPath, 'utf8');
  }
  return evaluateChangedLineCoverage({
    diff: diffResult.stdout,
    lcov,
    packageRoot,
    threshold,
    repoRoot,
  });
}

function main() {
  const [logPath, rawStatus, rawTolerance, lcovPath, changedBase, packageRoot, rawChangedThreshold] = process.argv.slice(2);
  const status = Number(rawStatus);
  if (!logPath || !Number.isInteger(status) || status < 0 || status > 255 || !['true', 'false'].includes(rawTolerance)) {
    throw new Error('Usage: check-coverage-result.mjs <log-path> <status:0-255> <tolerate-pool-crash:true|false> [<lcov-path> <changed-base-sha> <package-root:.|web-ui> <changed-line-threshold>]');
  }

  const result = evaluateCoverageResult(readFileSync(logPath, 'utf8'), status, rawTolerance === 'true');
  if (result.warning) process.stdout.write(`::warning::${result.warning}\n`);
  if (!result.ok) {
    process.stderr.write(`::error::${result.message}\n`);
    process.exitCode = result.status || 1;
    return;
  }

  const changedArgs = [lcovPath, changedBase, packageRoot, rawChangedThreshold];
  if (changedArgs.some(Boolean) && !changedArgs.every(Boolean)) {
    throw new Error('changed-line coverage requires lcov path, base SHA, package root, and threshold together');
  }
  if (changedArgs.every(Boolean)) {
    const changed = changedCoverageFromGit(resolve(lcovPath), changedBase, packageRoot, Number(rawChangedThreshold));
    const stream = changed.ok ? process.stdout : process.stderr;
    stream.write(`${changed.ok ? '' : '::error::'}${changed.message}\n`);
    if (!changed.ok) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
