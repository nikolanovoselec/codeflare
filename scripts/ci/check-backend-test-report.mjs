// Fail-closed gate for the backend vitest run (Cloudflare Workers pool).
//
// @cloudflare/vitest-pool-workers crashes workerd at pool teardown AFTER all
// tests pass (known-issues#websockets: WebSockets + Durable Objects under
// per-file storage isolation; still present on 0.18.x / vitest 4 — the
// documented alternative `--max-workers=1 --no-isolate` crashes this suite at
// collection, verified in CI). The crash poisons the process exit code, so
// exit-code-only gating would fail every green run. The run therefore writes a
// machine-readable JSON report and this gate decides from parsed counts, never
// from reporter prose:
//
//   exit 0    -> still require a parseable report with >0 tests and 0 failures
//                (catches a mis-sharded or silently-empty run)
//   exit != 0 -> accept ONLY when the report parses, shows >0 tests and 0
//                failed tests/suites, AND the log carries the exact pool-crash
//                fingerprint. Anything else — missing/corrupt report, unknown
//                error text, zero collected tests — fails.
//
// Usage: node scripts/ci/check-backend-test-report.mjs <exit-status> <report.json> <run.log>
import { readFileSync } from 'node:fs';

const [, , exitStatus, reportPath, logPath] = process.argv;
const status = Number(exitStatus);

function fail(msg) {
  console.error(`::error::backend-test gate: ${msg}`);
  process.exit(1);
}

if (!Number.isInteger(status) || !reportPath || !logPath) {
  fail(`invalid arguments: status=${exitStatus} report=${reportPath} log=${logPath}`);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  fail(`cannot read/parse ${reportPath} (${e.message}) — treating the run as failed`);
}

const failedTests = report.numFailedTests;
const failedSuites = report.numFailedTestSuites;
const total = report.numTotalTests;
if (![failedTests, failedSuites, total].every(Number.isInteger)) {
  fail('report is missing numFailedTests/numFailedTestSuites/numTotalTests');
}
if (total === 0) fail('report shows 0 collected tests');
if (failedTests > 0 || failedSuites > 0) {
  fail(`${failedTests} failed test(s) / ${failedSuites} failed suite(s)`);
}

if (status === 0) {
  console.log(`backend-test gate: ${total} tests, 0 failures`);
  process.exit(0);
}

const FINGERPRINT = '[vitest-pool]: Worker cloudflare-pool emitted error.';
let log = '';
try {
  log = readFileSync(logPath, 'utf8');
} catch {
  // fall through: no log means the fingerprint check below fails closed
}
if (!log.includes(FINGERPRINT)) {
  fail(`non-zero exit (${status}) without the known workerd teardown fingerprint`);
}
console.log(
  `backend-test gate: ${total} tests, 0 failures; non-zero exit (${status}) matches the known workerd teardown crash — accepting`,
);
