import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLL_MS = 15_000, EMPTY_LIMIT_MS = 5 * 60_000, TOTAL_LIMIT_MS = 30 * 60_000;
const CHECK_FIELDS = 'bucket,link,name,state,workflow';

function exec(command, args, options = {}) {
  return new Promise((done) => {
    execFile(command, args, { cwd: options.cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      done({ stdout: stdout ?? '', stderr: stderr ?? '',
        exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0 });
    });
  });
}

function parseJson(result) {
  try { return JSON.parse(result.stdout); }
  catch { return null; }
}

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }

function summary(status, { repo, pr, head, reason = '', currentHead = '', rows = [] }) {
  const details = [`pr=${pr}`, `head=${head}`];
  if (repo) details.push(`repo=${repo}`);
  if (reason) details.push(reason);
  if (currentHead) details.push(`current_head=${currentHead}`);
  const lines = [`CI_RESULT ${status}`, details.join(' ')];
  const shown = status === 'success' ? rows.slice(0, 6) : rows;
  for (const row of shown) {
    lines.push(
      `check bucket=${clean(row.bucket)} name=${clean(row.name)} workflow=${clean(row.workflow)} state=${clean(row.state)} link=${clean(row.link)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function readHead({ repo, pr, runner, cwd }) {
  try {
    const result = await runner(
      'gh',
      ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'],
      { cwd },
    );
    const value = parseJson(result);
    return typeof value?.headRefOid === 'string' ? value.headRefOid : null;
  } catch {
    return null;
  }
}

export async function resolveCiMonitorRequest({ event, changed, repo, runner = exec, cwd } = {}) {
  if (!['push', 'pr-create'].includes(event) || changed !== true || !repo) return null;

  let result;
  try {
    result = await runner(
      'gh',
      ['pr', 'view', '--repo', repo, '--json', 'number,state,baseRefName,headRefOid'],
      { cwd },
    );
  } catch {
    return null;
  }
  const pr = parseJson(result);
  if (
    !pr ||
    pr.state !== 'OPEN' ||
    !['main', 'master'].includes(pr.baseRefName) ||
    !Number.isInteger(pr.number) ||
    !/^[0-9a-f]{40}$/i.test(pr.headRefOid ?? '')
  ) return null;

  return {
    subagent_type: 'ci-monitor',
    description: `Monitor PR #${pr.number} CI`,
    prompt: `repo=${repo} pr=${pr.number} head=${pr.headRefOid}`,
    run_in_background: true,
    inherit_context: false,
    max_turns: 2,
  };
}

export async function monitorCi({
  repo,
  pr,
  head,
  runner = exec,
  cwd,
  clock = { now: Date.now },
  sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
} = {}) {
  const base = { repo, pr, head };
  if (!repo || !Number.isInteger(pr) || !/^[0-9a-f]{40}$/i.test(head ?? '')) {
    return summary('timeout', { ...base, reason: 'invalid_request' });
  }
  const startedAt = clock.now();
  let fingerprint = '';
  let stablePolls = 0;

  while (clock.now() - startedAt < TOTAL_LIMIT_MS) {
    const beforeHead = await readHead({ repo, pr, runner, cwd });
    if (beforeHead && beforeHead !== head) {
      return summary('timeout', { ...base, reason: 'superseded', currentHead: beforeHead });
    }
    if (!beforeHead) {
      await sleep(POLL_MS);
      continue;
    }

    let rows = null;
    try {
      const result = await runner(
        'gh',
        ['pr', 'checks', String(pr), '--repo', repo, '--json', CHECK_FIELDS],
        { cwd },
      );
      const parsed = parseJson(result);
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      rows = null;
    }

    if (rows?.length === 0 && clock.now() - startedAt >= EMPTY_LIMIT_MS) {
      return summary('timeout', { ...base, reason: 'no_checks_registered' });
    }

    if (rows?.length) {
      const failing = rows.filter((row) => ['fail', 'cancel'].includes(row.bucket));
      const terminal = rows.every((row) => ['pass', 'skipping'].includes(row.bucket));
      if (failing.length || terminal) {
        const afterHead = await readHead({ repo, pr, runner, cwd });
        if (afterHead && afterHead !== head) {
          return summary('timeout', { ...base, reason: 'superseded', currentHead: afterHead });
        }
        if (!afterHead) {
          fingerprint = '';
          stablePolls = 0;
          await sleep(POLL_MS);
          continue;
        }
      }
      if (failing.length) return summary('failure', { ...base, rows: failing });
      if (terminal) {
        const nextFingerprint = rows
          .map((row) => [row.name, row.workflow, row.link].map(clean).join('\u0000'))
          .sort()
          .join('\u0001');
        stablePolls = nextFingerprint === fingerprint ? stablePolls + 1 : 1;
        fingerprint = nextFingerprint;
        if (stablePolls >= 2) return summary('success', { ...base, rows });
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

  return summary('timeout', { ...base, reason: 'deadline_exceeded' });
}

function cliOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const split = token.indexOf('=');
    if (split > 0) options[token.slice(0, split).replace(/^--/, '')] = token.slice(split + 1);
    else if (token.startsWith('--') && args[index + 1]) options[token.slice(2)] = args[++index];
  }
  if ('changed' in options) options.changed = options.changed === 'true';
  if ('pr' in options) options.pr = Number(options.pr);
  return options;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const options = cliOptions(args);
  if (mode === 'request') {
    const request = await resolveCiMonitorRequest(options);
    if (request) process.stdout.write(`${JSON.stringify(request)}\n`);
    return;
  }
  if (mode === 'monitor') {
    process.stdout.write(await monitorCi(options));
    return;
  }
  process.stderr.write('usage: monitor-ci.mjs request|monitor key=value ...\n');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
