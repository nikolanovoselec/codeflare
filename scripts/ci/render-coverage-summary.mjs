// Lift the coverage totals out of a vitest run log onto the run summary.
//
// Reporting only — vitest already enforced the thresholds from the suite's own
// config and failed the step if they were missed. This exists so the numbers are
// visible without opening the log, and so a run shows whether coverage is
// sitting on the threshold or comfortably above it.
//
// Usage: node scripts/ci/render-coverage-summary.mjs <run.log> <suite-label>
import { readFileSync } from 'node:fs';

const [, , logPath, label = 'suite'] = process.argv;

let log = '';
try {
  log = readFileSync(logPath, 'utf8');
} catch {
  console.log(`_No coverage log for ${label}._`);
  process.exit(0);
}

// The istanbul text reporter (v8 reports a flat 0% under workerd) prints a
// table whose "All files" row carries the totals — the format is identical:
//   All files          |   53.42 |    43.01 |   54.2  |   53.42 |
const row = log.match(/^\s*All files\s*\|([^\n]*)$/m);
if (!row) {
  console.log(`_Coverage table not found in the ${label} log._`);
  process.exit(0);
}

const nums = row[1]
  .split('|')
  .map((c) => Number.parseFloat(c.trim()))
  .filter((n) => Number.isFinite(n));

if (nums.length < 4) {
  console.log(`_Coverage table for ${label} did not parse._`);
  process.exit(0);
}

const [statements, branches, functions, lines] = nums;
console.log(`## Coverage — ${label}\n`);
console.log('| Statements | Branches | Functions | Lines |');
console.log('|---|---|---|---|');
console.log(`| ${statements}% | ${branches}% | ${functions}% | ${lines}% |`);
console.log(
  `\n_Thresholds are enforced by vitest from the suite's own config; this table is the reported result._`,
);
