// Enforce the Worker bundle size budget from wrangler's own dry-run output.
//
// Wrangler prints the exact figure Cloudflare enforces:
//
//   Total Upload: 1234.56 KiB / gzip: 234.56 KiB
//
// Parsing that is better than measuring the outdir ourselves — it is the same
// number the platform applies at deploy time, including whatever wrangler
// decides to bundle. Anything we computed independently would be an estimate
// that drifts from the thing that actually rejects a deploy.
//
// Usage: node scripts/ci/check-bundle-size.mjs <wrangler-dry-run.log>
import { appendFileSync, readFileSync } from 'node:fs';
import { BUDGETS } from './size-budgets.mjs';

const [, , logPath] = process.argv;

function fail(msg) {
  console.error(`::error::bundle-size gate: ${msg}`);
  process.exit(1);
}

let log;
try {
  log = readFileSync(logPath, 'utf8');
} catch (e) {
  fail(`cannot read ${logPath} (${e.message})`);
}

// Wrangler colourises and may wrap; match the numbers, not the layout.
const m = log.match(/Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/i);
if (!m) {
  fail(
    'wrangler printed no "Total Upload: … / gzip: …" line — the dry run did not produce a bundle, so its size is unverified',
  );
}

const rawKiB = Number(m[1]);
const gzipKiB = Number(m[2]);
if (!Number.isFinite(rawKiB) || !Number.isFinite(gzipKiB) || gzipKiB <= 0) {
  fail(`parsed a nonsensical size from wrangler output: raw=${m[1]} gzip=${m[2]}`);
}

const { label, limitKiB, budgetKiB } = BUDGETS.worker;
const pctOfLimit = ((gzipKiB / limitKiB) * 100).toFixed(1);

const summary = [
  '## Bundle size\n',
  '| Bundle | Raw | Gzipped | Budget | Platform limit | Used |',
  '|---|---|---|---|---|---|',
  `| ${label} | ${rawKiB.toFixed(1)} KiB | **${gzipKiB.toFixed(1)} KiB** | ${
    budgetKiB ? `${budgetKiB} KiB` : '_not yet set_'
  } | ${limitKiB} KiB | ${pctOfLimit}% |`,
  '',
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}
console.log(summary);

// `=== null` only recognises the literal sentinel. A deleted or misspelled
// budgetKiB is undefined, which falls through to `gzipKiB > undefined` — NaN
// comparison, always false — so the gate passed a bundle of any size while
// printing "within the undefined KiB budget". Anything that is not a positive
// number is a misconfiguration, not a licence to skip the check.
if (budgetKiB !== null && !(typeof budgetKiB === 'number' && Number.isFinite(budgetKiB) && budgetKiB > 0)) {
  fail(`budgetKiB for ${label} is ${JSON.stringify(budgetKiB)}; expected a positive number or null to opt out`);
}

if (budgetKiB === null) {
  console.log(
    `::notice title=bundle size::${label} is ${gzipKiB.toFixed(1)} KiB gzipped (${pctOfLimit}% of the ${limitKiB} KiB platform limit). No budget set yet — set budgetKiB in scripts/ci/size-budgets.mjs to start enforcing.`,
  );
  process.exit(0);
}

if (gzipKiB > budgetKiB) {
  fail(
    `${label} is ${gzipKiB.toFixed(1)} KiB gzipped, over the ${budgetKiB} KiB budget. ` +
      `Cloudflare's hard limit is ${limitKiB} KiB, so this is not yet a broken deploy — but the budget exists to catch growth ` +
      `while there is still headroom. Either trim the bundle or raise budgetKiB in scripts/ci/size-budgets.mjs deliberately.`,
  );
}

console.log(
  `bundle-size gate: ${label} ${gzipKiB.toFixed(1)} KiB gzipped, within the ${budgetKiB} KiB budget (${pctOfLimit}% of the ${limitKiB} KiB platform limit)`,
);
