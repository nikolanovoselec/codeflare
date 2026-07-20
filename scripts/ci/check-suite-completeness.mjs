// Cross-shard completeness gate for the backend suite.
//
// The per-shard gate (check-backend-test-report.mjs) proves that every file a
// shard REPORTED collected tests and passed. It cannot prove that every file on
// disk was reported at all: a file dropped by a mis-shard, a stale exclude, or a
// worker dying mid-run simply never appears, and a run of 190 files looks
// exactly as green as a run of 194. Running the Workers pool across several
// workers widens that window, so the shard reports are reconciled here — in the
// aggregate job that owns the required `test` context — against the test files
// actually present in the tree.
//
// Usage: node scripts/ci/check-suite-completeness.mjs <artifact-root> <lane-result>
// <lane-result> is the backend lane's `needs.*.result`. Missing reports are fine
// when the lane was skipped by the path filter, and a hard failure when it
// reported success — otherwise a flaky artifact download would silently disarm
// this gate.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NODE_SUITE_FILES } from '../../vitest.node-suite.mjs';

const [, , root, laneResult] = process.argv;

function fail(msg) {
  console.error(`::error::suite-completeness gate: ${msg}`);
  process.exit(1);
}

// Collect every file under `dir` whose name satisfies `keep`.
function collect(dir, keep, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) collect(p, keep, out);
    else if (keep(e)) out.push(p);
  }
  return out;
}

const reports = root ? collect(root, (e) => e.endsWith('.json')) : [];

if (!reports.length) {
  if (laneResult === 'success') {
    fail('the backend lane succeeded but uploaded no reports — cannot verify coverage');
  }
  console.log(
    `suite-completeness gate: no backend reports and lane result is "${laneResult}" — nothing to reconcile`,
  );
  process.exit(0);
}

// Expected: every backend test file in the tree, whichever runtime runs it.
// The Workers config's include glob and the Node suite together must cover them.
const expected = new Set(
  collect('src', (e) => e.endsWith('.test.ts')).map((p) => p.replaceAll('\\', '/')),
);
for (const f of NODE_SUITE_FILES) {
  if (!expected.has(f)) fail(`vitest.node-suite.mjs lists ${f}, which does not exist`);
}
if (expected.size === 0) fail('found no src/**/*.test.ts files — refusing to pass vacuously');

// Reported: the union across every shard's Workers report and the Node report.
// Report names are absolute paths from the runner's checkout; anchor them at the
// repo-relative `src/` segment so they compare against the glob results.
const reported = new Set();
for (const p of reports) {
  let r;
  try {
    r = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    fail(`cannot parse ${relative(root, p)} — a shard's report is missing or corrupt`);
  }
  if (!Array.isArray(r.testResults)) fail(`${relative(root, p)} has no testResults array`);
  for (const t of r.testResults) {
    const name = String(t.name ?? '').replaceAll('\\', '/');
    const i = name.lastIndexOf('/src/');
    reported.add(i === -1 ? name : name.slice(i + 1));
  }
}

const missing = [...expected].filter((f) => !reported.has(f)).sort();
if (missing.length) {
  fail(
    `${missing.length} backend test file(s) present in the tree ran in no shard:\n  ${missing.join('\n  ')}`,
  );
}

const unknown = [...reported].filter((f) => !expected.has(f)).sort();
if (unknown.length) {
  fail(`shard reports name ${unknown.length} file(s) not found in the tree:\n  ${unknown.join('\n  ')}`);
}

console.log(
  `suite-completeness gate: ${expected.size} backend test file(s) accounted for across ${reports.length} report(s)`,
);
