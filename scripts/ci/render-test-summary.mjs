// Render the vitest JSON reports uploaded by the backend shards as a
// markdown table on the workflow run summary. Reporting only: exits 0 with
// a note when no reports exist (backend lane skipped) and skips malformed
// reports — the fail-closed gate already ran inside the shard jobs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2];
const reports = [];
const walk = (dir) => {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p);
    else if (e.endsWith('.json')) reports.push(p);
  }
};
if (root) walk(root);

if (!reports.length) {
  console.log('_Backend lane skipped — no test reports to summarize._');
  process.exit(0);
}

const fmt = (ms) =>
  ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s` : `${(ms / 1000).toFixed(1)}s`;

const rows = [];
const slow = [];
for (const p of reports.sort()) {
  let r;
  try { r = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  if (!Array.isArray(r.testResults)) continue;
  const label = relative(root, p).replace('backend-tests-', '').replace(/\.json$/, '').replace('/', ' · ');
  const starts = r.testResults.map((t) => t.startTime).filter(Number.isFinite);
  const ends = r.testResults.map((t) => t.endTime).filter(Number.isFinite);
  const wall = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0;
  rows.push(`| ${label} | ${r.testResults.length} | ${r.numTotalTests ?? '?'} | ${r.numFailedTests ?? '?'} | ${fmt(wall)} |`);
  for (const t of r.testResults) {
    if (Number.isFinite(t.startTime) && Number.isFinite(t.endTime)) {
      slow.push({ name: (t.name || '').replace(/^.*?(src|host)\//, '$1/'), ms: t.endTime - t.startTime });
    }
  }
}

console.log('## Backend test results\n');
console.log('| Report | Files | Tests | Failed | Wall clock |');
console.log('|---|---|---|---|---|');
for (const row of rows) console.log(row);
const top = slow.sort((a, b) => b.ms - a.ms).slice(0, 5);
if (top.length) {
  console.log('\n<details><summary>Slowest test files</summary>\n');
  for (const t of top) console.log(`- \`${t.name}\` — ${fmt(t.ms)}`);
  console.log('\n</details>');
}
