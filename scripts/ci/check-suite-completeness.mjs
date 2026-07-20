// Cross-shard completeness gate for every test suite.
//
// The per-run gate (check-vitest-report.mjs) proves that every file a run
// REPORTED collected tests and passed. It cannot prove that every file on disk
// was reported at all: a file dropped by a mis-shard, a stale exclude, or a
// worker dying mid-run simply never appears, and a run of 190 files looks
// exactly as green as a run of 194. Sharding and parallel pools both widen that
// window, so the shard reports are reconciled here — in the aggregate job that
// owns the required `test` context — against the test files actually in the
// tree, for every suite listed in suites.mjs.
//
// Usage: node scripts/ci/check-suite-completeness.mjs <artifact-root> <lane-results-json>
// <lane-results-json> maps each suite's `lane` to its GitHub job result. Missing
// reports are fine when that lane was skipped by the path filter, and a hard
// failure when it reported success — otherwise a flaky artifact download would
// silently disarm the gate.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SUITES, NODE_SUITE_FILES } from './suites.mjs';

const [, , root, laneJson] = process.argv;

let failures = 0;
function fail(msg) {
  console.error(`::error::suite-completeness gate: ${msg}`);
  failures++;
}

let laneResults = {};
try {
  laneResults = JSON.parse(laneJson ?? '{}');
} catch {
  console.error('::error::suite-completeness gate: lane-results argument is not JSON');
  process.exit(1);
}

/** Every file under `dir` (recursively) satisfying `keep`. */
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
    else if (keep(e, p)) out.push(p);
  }
  return out;
}

// Artifact directories are named after the artifact, so a suite claims its
// reports by directory-name prefix rather than by guessing at file contents.
const artifactDirs = (() => {
  try {
    return readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
  } catch {
    return [];
  }
})();

for (const suite of SUITES) {
  // `laneResults[missing]` is undefined, and undefined !== 'success' takes the
  // "lane was skipped, nothing to reconcile" branch — so adding a suite to
  // suites.mjs without adding its lane to the LANES env in test.yml silently
  // disarms the reconciler for that suite, which is the opposite of what
  // suites.mjs promises. A JSON scalar or '{}' disarms all of them at once.
  if (!Object.prototype.hasOwnProperty.call(laneResults, suite.lane)) {
    fail(`${suite.name}: no lane result was passed for "${suite.lane}" — the reconciler cannot tell a skipped lane from a missing one. Add it to the LANES argument in test.yml.`);
  }
  const laneResult = laneResults[suite.lane];
  const dirs = artifactDirs.filter((d) => suite.artifacts.some((a) => d.startsWith(a)));
  const reports = dirs.flatMap((d) => collect(join(root, d), (e) => e.endsWith('.json')));

  if (!reports.length) {
    if (laneResult === 'success') {
      fail(`${suite.name}: lane succeeded but uploaded no reports — cannot verify coverage`);
    } else {
      console.log(`${suite.name}: no reports, lane result "${laneResult}" — nothing to reconcile`);
    }
    continue;
  }

  const excluded = new Set([...(suite.exclude ?? [])]);
  const expected = new Set(
    collect(suite.dir, (e) => suite.extensions.some((x) => e.endsWith(x)))
      .map((p) => p.replaceAll('\\', '/'))
      .filter((p) => !excluded.has(p)),
  );
  if (expected.size === 0) {
    fail(`${suite.name}: found no test files under ${suite.dir} — refusing to pass vacuously`);
    continue;
  }

  // Report names are absolute paths from the runner's checkout; anchor them at
  // the suite's own directory so they compare against the tree-relative set.
  const anchor = `/${suite.dir}/`;
  const reported = new Set();
  const seenIn = new Map(); // file -> [report names]
  let malformed = false;
  for (const p of reports) {
    let r;
    try {
      r = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      fail(`${suite.name}: cannot parse ${relative(root, p)} — a report is missing or corrupt`);
      malformed = true;
      continue;
    }
    if (!Array.isArray(r.testResults)) {
      fail(`${suite.name}: ${relative(root, p)} has no testResults array`);
      malformed = true;
      continue;
    }
    for (const t of r.testResults) {
      const name = String(t.name ?? '').replaceAll('\\', '/');
      const i = name.lastIndexOf(anchor);
      const rel = i === -1 ? name : name.slice(i + 1);
      reported.add(rel);
      seenIn.set(rel, [...(seenIn.get(rel) ?? []), relative(root, p)]);
    }
  }
  if (malformed) continue;

  // A file claimed by two shards means the split disagreed — the shards ran
  // different partitions of the same tree. It costs time, and the same
  // disagreement in the other direction is a file nobody ran, so it is worth
  // catching in its own right rather than only via the missing-file check.
  const duplicated = [...seenIn.entries()].filter(([, where]) => where.length > 1);
  if (duplicated.length) {
    fail(
      `${suite.name}: ${duplicated.length} file(s) ran in more than one report:\n  ${duplicated
        .map(([f, where]) => `${f} → ${where.join(', ')}`)
        .join('\n  ')}`,
    );
  }

  const missing = [...expected].filter((f) => !reported.has(f)).sort();
  if (missing.length) {
    fail(
      `${suite.name}: ${missing.length} test file(s) present in the tree ran nowhere:\n  ${missing.join('\n  ')}`,
    );
  }
  const unknown = [...reported].filter((f) => !expected.has(f)).sort();
  if (unknown.length) {
    fail(
      `${suite.name}: reports name ${unknown.length} file(s) not found in the tree:\n  ${unknown.join('\n  ')}`,
    );
  }
  if (!missing.length && !unknown.length) {
    console.log(
      `${suite.name}: ${expected.size} test file(s) accounted for across ${reports.length} report(s)`,
    );
  }
}

// The backend tree is split across two runtimes; a file must be claimed by
// exactly one, or it either runs twice or (worse) silently stops running.
const backendFiles = new Set(
  collect('src', (e) => e.endsWith('.test.ts')).map((p) => p.replaceAll('\\', '/')),
);
for (const f of NODE_SUITE_FILES) {
  if (!backendFiles.has(f)) fail(`vitest.node-suite.mjs lists ${f}, which does not exist`);
}

process.exit(failures ? 1 : 0);
