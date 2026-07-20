// Fail-closed gate for a vitest run. Every suite in this repo — backend shards,
// the Node-runtime leg, frontend shards, landing — goes through it, so none can
// rot green in a way another one would have caught.
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
//   exit != 0 -> fails, UNLESS the caller opted into pool-crash tolerance AND
//                the report parses with >0 tests and 0 failed tests/suites AND
//                the log carries the exact fingerprint. Anything else — missing
//                or corrupt report, unknown error text, zero collected tests —
//                fails.
//
// Tolerance is opt-in per suite, not global: only the Workers pool has this
// bug, so a non-zero exit from the jsdom or Node suites must stay fatal.
//
// Usage: node scripts/ci/check-vitest-report.mjs <exit-status> <report.json> <run.log> [tolerate-pool-crash]
import { readFileSync } from 'node:fs';

const [, , exitStatus, reportPath, logPath, tolerate] = process.argv;
const status = Number(exitStatus);
const tolerantOfPoolCrash = tolerate === 'true';

function fail(msg) {
  console.error(`::error::vitest gate: ${msg}`);
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

// Skipped tests still count toward numTotalTests and still populate
// assertionResults, so a suite with every test `.skip`ped passes every other
// check here while asserting nothing. vitest's own `allowOnly: !CI` default
// already fails `.only` in CI; `.skip` has no such backstop, so it gets one.
const pending = report.numPendingTests ?? 0;
const todo = report.numTodoTests ?? 0;
if (pending > 0 || todo > 0) {
  fail(
    `${pending} skipped and ${todo} todo test(s). A skipped test asserts nothing but still ` +
      `counts as collected, so it cannot be allowed to satisfy this gate. Remove the skip, ` +
      `or delete the test if it is not meant to run.`,
  );
}
if (failedTests > 0 || failedSuites > 0) {
  fail(`${failedTests} failed test(s) / ${failedSuites} failed suite(s)`);
}

// A test file that contributes ZERO tests is a collection casualty (workerd
// dies loading the file; the old grep guard silently accepted this — 7 files
// were dead for weeks while runs stayed green). Zero-test files fail loudly.
// NOT `Array.isArray(...) ? ... : []`. That turned a report with no per-file
// data into "no zero-assertion files found" and passed: {"numTotalTests":5,
// "numFailedTests":0,"numFailedTestSuites":0} with no testResults key cleared
// the gate whose entire premise is that the exit code is untrustworthy so the
// report must be believed. The downstream reconciler already fails closed on
// this exact shape; the per-run gate should not be the weaker of the two.
if (!Array.isArray(report.testResults)) {
  fail("report has no testResults array, so no per-file evidence exists to check");
}
const results = report.testResults;
// The summary counts and the per-file detail must agree. A report that claims
// N tests while carrying assertions for fewer is not a report we can gate on.
const asserted = results.reduce(
  (n, f) => n + (Array.isArray(f.assertionResults) ? f.assertionResults.length : 0), 0);
if (asserted !== total) {
  fail(`report claims ${total} tests but carries ${asserted} assertion result(s) — the summary and the per-file detail disagree`);
}
const empty = results.filter((r) => (r.assertionResults ?? []).length === 0);
if (empty.length > 0) {
  const names = empty.map((r) => r.name ?? '?').join('\n  ');
  fail(`${empty.length} test file(s) collected zero tests (collection crash):\n  ${names}`);
}

if (status === 0) {
  console.log(`vitest gate: ${total} tests, 0 failures`);
  process.exit(0);
}

if (!tolerantOfPoolCrash) {
  fail(`non-zero exit (${status}); this suite does not tolerate pool crashes`);
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
  `vitest gate: ${total} tests, 0 failures; non-zero exit (${status}) matches the known workerd teardown crash — accepting`,
);
