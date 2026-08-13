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

// `limitKiB` is the platform's hard ceiling — the number Cloudflare itself
// enforces. `budgetKiB` is ours: set close to current usage so unexpected
// growth is visible while there is still headroom to react. A budget parked at
// the platform limit would never fire and would be theater.
const BUDGETS = {
  worker: {
    label: 'Worker script (gzipped)',
    // Workers paid plan. The free plan is 3 MiB; codeflare runs containers,
    // which is paid-only, so 10 MiB is the ceiling that actually applies.
    limitKiB: 10 * 1024,
    // Measured 3705.85 KiB on 2026-07-20 (run 29724182607). ~13% headroom:
    // enough that ordinary feature work does not trip it, tight enough that a
    // step change — a dependency pulled into the Worker, a seed that stops
    // being trimmed — fails the PR that caused it instead of the next deploy.
    //
    // Worth knowing: 3705 KiB is already past the 3 MiB free-plan ceiling, so
    // this Worker cannot deploy on the free plan regardless of the budget.
    // Most of it is src/lib/agent-seed.generated.ts.
    //
    // Raised 4200 -> 6000 on 2026-07-27. Measured 4231.1 KiB (run 30228756909).
    // The gate fired on intentional growth: the reviewer-economics work added
    // ~518 KiB of seed by embedding each lane's policy into its agent document,
    // which is what took a review round from 13 turns to 6.
    //
    // Raised 6000 -> 6800 on 2026-08-13. Measured 6462.5 KiB (run 31724293451).
    // The advanced design suite added an on-demand UI/UX dataset and its
    // runtime search implementation across every skill-capable agent. Removing
    // that generated fan-out would undo the feature. 6800 keeps a 337 KiB
    // regression margin while leaving 3440 KiB below the paid-plan hard limit.
    budgetKiB: 6800,
  },
};

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
// matchAll, not match: a log carrying two measurements — a retried dry run, or
// a multi-environment one — would otherwise gate on whichever printed FIRST
// rather than on the largest, so a bundle that grew past budget on the second
// pass could pass on the first pass's number. Ambiguity here is a
// misconfiguration, so it fails rather than picking.
const matches = [...log.matchAll(/Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/gi)];
if (matches.length > 1) {
  fail(`wrangler printed ${matches.length} "Total Upload" lines; refusing to guess which bundle this gate is measuring`);
}
const m = matches[0];
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
    `::notice title=bundle size::${label} is ${gzipKiB.toFixed(1)} KiB gzipped (${pctOfLimit}% of the ${limitKiB} KiB platform limit). No budget set yet — set budgetKiB in this file to start enforcing.`,
  );
  process.exit(0);
}

if (gzipKiB > budgetKiB) {
  fail(
    `${label} is ${gzipKiB.toFixed(1)} KiB gzipped, over the ${budgetKiB} KiB budget. ` +
      `Cloudflare's hard limit is ${limitKiB} KiB, so this is not yet a broken deploy — but the budget exists to catch growth ` +
      `while there is still headroom. Either trim the bundle or raise budgetKiB in scripts/ci/check-bundle-size.mjs deliberately.`,
  );
}

console.log(
  `bundle-size gate: ${label} ${gzipKiB.toFixed(1)} KiB gzipped, within the ${budgetKiB} KiB budget (${pctOfLimit}% of the ${limitKiB} KiB platform limit)`,
);
