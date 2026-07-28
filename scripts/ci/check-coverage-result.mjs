#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const COVERAGE_TABLE = /^\s*All files\s*\|/m;
const FAILED_TESTS = /^ *Tests +.*failed/m;
const THRESHOLD_MISS = /does not meet .*threshold/;
const POOL_CRASH = '[vitest-pool]: Worker cloudflare-pool emitted error.';

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
      return { ok: true, warning: 'tolerating the known workerd teardown crash (coverage table and thresholds both verified above)' };
    }
    return { ok: false, message: `coverage run failed with status ${status}`, status };
  }
  return { ok: true };
}

function main() {
  const [logPath, rawStatus, rawTolerance] = process.argv.slice(2);
  const status = Number(rawStatus);
  if (!logPath || !Number.isInteger(status) || status < 0 || status > 255 || !['true', 'false'].includes(rawTolerance)) {
    throw new Error('Usage: check-coverage-result.mjs <log-path> <status:0-255> <tolerate-pool-crash:true|false>');
  }

  const result = evaluateCoverageResult(readFileSync(logPath, 'utf8'), status, rawTolerance === 'true');
  if (result.warning) process.stdout.write(`::warning::${result.warning}\n`);
  if (!result.ok) {
    process.stderr.write(`::error::${result.message}\n`);
    process.exitCode = result.status || 1;
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
