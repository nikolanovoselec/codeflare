import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLL_MS = 15_000, EMPTY_LIMIT_MS = 5 * 60_000, TOTAL_LIMIT_MS = 8 * 60_000;
const RUN_FIELDS = 'databaseId,workflowName,headSha,status,conclusion,event,url';
const TERMINAL_OK = new Set(['success', 'skipped']);

export function runCommand(command, args, options = {}) {
  return new Promise((done) => {
    execFile(command, args, { cwd: options.cwd, encoding: 'utf8', timeout: options.timeout ?? 60_000 }, (error, stdout, stderr) => {
      done({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0 });
    });
  });
}

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function validUrl(value) {
  if (typeof value !== 'string') return false;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); }
  catch { return false; }
}
function validRun(row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    && Number.isInteger(row.databaseId)
    && ['workflowName', 'headSha', 'status', 'conclusion', 'event'].every((field) => typeof row[field] === 'string')
    && validUrl(row.url);
}
function parseRows(result, head) {
  try {
    const rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows) || !rows.every(validRun)) return null;
    return rows.filter((row) => row.headSha === head);
  } catch { return null; }
}
function summary(status, { repo, pr, head, reason = '', rows = [] }) {
  const details = [`pr=${pr}`, `head=${head}`, `repo=${repo}`];
  if (reason) details.push(reason);
  const lines = [`CI_RESULT ${status}`, details.join(' ')];
  for (const row of rows) lines.push(`run id=${row.databaseId} workflow=${clean(row.workflowName)} conclusion=${clean(row.conclusion)} link=${clean(row.url)}`);
  return `${lines.join('\n')}\n`;
}

export async function monitorCi({ repo, pr, head, branch, runner = runCommand, cwd, clock = { now: Date.now }, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !Number.isInteger(pr) || pr <= 0
    || !/^[0-9a-f]{40}$/i.test(head ?? '') || typeof branch !== 'string' || !branch.trim()) {
    return summary('timeout', { repo, pr, head, reason: 'invalid_request' });
  }

  const startedAt = clock.now();
  let fingerprint = '', stablePolls = 0;
  while (clock.now() - startedAt < TOTAL_LIMIT_MS) {
    let rows = null;
    try {
      const result = await runner('gh', ['run', 'list', '--repo', repo, '--branch', branch, '--limit', '24', '--json', RUN_FIELDS], { cwd });
      rows = parseRows(result, head);
    } catch { rows = null; }

    if (rows?.length === 0 && clock.now() - startedAt >= EMPTY_LIMIT_MS) {
      return summary('timeout', { repo, pr, head, reason: 'no_checks_registered' });
    }
    if (rows?.length) {
      const failed = rows.filter((row) => row.status === 'completed' && !TERMINAL_OK.has(row.conclusion));
      if (failed.length) return summary('failure', { repo, pr, head, rows: failed });
      const terminal = rows.every((row) => row.status === 'completed' && TERMINAL_OK.has(row.conclusion));
      if (terminal) {
        const next = rows.map((row) => `${row.databaseId}:${row.workflowName}:${row.event}`).sort().join('|');
        stablePolls = next === fingerprint ? stablePolls + 1 : 1;
        fingerprint = next;
        if (stablePolls >= 2) return summary('success', { repo, pr, head, rows: rows.slice(0, 6) });
      } else {
        fingerprint = '';
        stablePolls = 0;
      }
    } else {
      fingerprint = '';
      stablePolls = 0;
    }
    await sleep(POLL_MS);
  }
  return summary('timeout', { repo, pr, head, reason: 'deadline_exceeded' });
}

function cliOptions(args) {
  const options = {};
  for (const token of args) {
    const split = token.indexOf('=');
    if (split > 0) options[token.slice(0, split).replace(/^--/, '')] = token.slice(split + 1);
  }
  if ('pr' in options) options.pr = Number(options.pr);
  return options;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode !== 'monitor') {
    process.stderr.write('usage: monitor-ci.mjs monitor repo=<owner/repo> pr=<number> head=<sha> branch=<branch>\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(await monitorCi(cliOptions(args)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
