#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ADVISORY = 'GHSA-fc5q-39xc-vjpf';
const ADVISORY_URL = `https://github.com/advisories/${ADVISORY}`;
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

async function readGitHubAdvisory() {
  const { stdout } = await promisify(execFile)('gh', [
    'api', '--hostname', 'github.com', `/advisories/${ADVISORY}`,
  ], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Assess npm audit v2 output at --audit-level=high; reject by throwing. */
export async function assessBrowserIdeAudit(report, auditExitCode, readAdvisory = readGitHubAdvisory) {
  if (auditExitCode !== 0 && auditExitCode !== 1) throw new Error('Unsupported npm audit exit code');
  if (!object(report) || Object.hasOwn(report, 'error') || report.auditReportVersion !== 2 ||
      !object(report.vulnerabilities) || !object(report.metadata?.vulnerabilities)) {
    throw new Error('Malformed npm audit report or registry error');
  }

  const findings = new Map(Object.entries(report.vulnerabilities));
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]));
  const dependents = new Map([...findings.keys()].map(name => [name, []]));
  for (const [name, finding] of findings) {
    if (!text(name) || !object(finding) || finding.name !== name || !SEVERITIES.includes(finding.severity) ||
        !Array.isArray(finding.via) || finding.via.length === 0) {
      throw new Error('Malformed npm audit finding');
    }
    counts[finding.severity] += 1;
    for (const cause of finding.via) {
      if (typeof cause === 'string') {
        if (!findings.has(cause)) throw new Error('Dangling npm audit dependency cause');
        dependents.get(cause).push(name);
      } else if (!object(cause) || !text(cause.name) || !text(cause.dependency) ||
                 !text(cause.url) || !SEVERITIES.includes(cause.severity)) {
        throw new Error('Malformed npm audit advisory cause');
      }
    }
  }
  for (const finding of findings.values()) {
    if (finding.via.some(cause => SEVERITIES.indexOf(typeof cause === 'string'
      ? findings.get(cause).severity : cause.severity) > SEVERITIES.indexOf(finding.severity))) {
      throw new Error('Inconsistent npm audit cause severity');
    }
  }
  for (const severity of SEVERITIES) {
    if (report.metadata.vulnerabilities[severity] !== counts[severity]) {
      throw new Error('Inconsistent npm audit vulnerability counts');
    }
  }
  if (report.metadata.vulnerabilities.total !== findings.size) {
    throw new Error('Inconsistent npm audit vulnerability total');
  }

  const blocking = [...findings.keys()].filter(name => ['high', 'critical'].includes(findings.get(name).severity));
  if (auditExitCode === 0 && blocking.length === 0) return { withdrawnFindings: [] };
  if (auditExitCode === 0 || blocking.length === 0) throw new Error('Inconsistent npm audit exit code');

  const reachable = new Set();
  const anchored = new Set();
  const pending = [...blocking];
  while (pending.length) {
    const name = pending.pop();
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const cause of findings.get(name).via) {
      if (typeof cause === 'string') {
        pending.push(cause);
      } else {
        if (name !== 'picomatch' || cause.name !== 'picomatch' || cause.dependency !== 'picomatch' ||
            cause.url !== ADVISORY_URL) {
          throw new Error('Blocking npm audit finding has an unapproved advisory cause');
        }
        anchored.add(name);
      }
    }
  }

  // Reverse reachability grounds each cause in the advisory without treating a
  // visited node as safe. An ungrounded cycle must not become an exception.
  const grounded = [...anchored];
  while (grounded.length) {
    for (const parent of dependents.get(grounded.pop())) {
      if (reachable.has(parent) && !anchored.has(parent)) {
        anchored.add(parent);
        grounded.push(parent);
      }
    }
  }
  if (anchored.size !== reachable.size) throw new Error('Ungrounded npm audit dependency cycle');

  let advisory;
  try {
    advisory = await readAdvisory(ADVISORY);
  } catch {
    // Do not expose gh stderr, credentials or reader/transport configuration.
    throw new Error('Unable to verify advisory withdrawal with GitHub');
  }
  if (!object(advisory) || advisory.ghsa_id !== ADVISORY ||
      !Array.isArray(advisory.vulnerabilities) ||
      !advisory.vulnerabilities.some(entry =>
        entry?.package?.ecosystem === 'npm' && entry.package.name === 'picomatch') ||
      !text(advisory.withdrawn_at) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(advisory.withdrawn_at) ||
      !Number.isFinite(Date.parse(advisory.withdrawn_at))) {
    throw new Error('GitHub did not confirm the matching withdrawn npm picomatch advisory');
  }
  return { withdrawnFindings: [...reachable].sort(), advisory: ADVISORY, withdrawnAt: advisory.withdrawn_at };
}

async function main() {
  const [path, code, ...extra] = process.argv.slice(2);
  if (!path || !['0', '1'].includes(code) || extra.length) {
    throw new Error('usage: check-browser-ide-audit.mjs <audit.json> <original-npm-exit-code: 0|1>');
  }
  let report;
  try {
    report = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Unable to read valid npm audit JSON');
  }
  const result = await assessBrowserIdeAudit(report, Number(code));
  console.log(result.advisory
    ? `Accepted ${result.withdrawnFindings.length} findings deriving only from ${result.advisory}; GitHub confirms withdrawal at ${result.withdrawnAt}.`
    : 'Browser IDE npm audit passed at --audit-level=high.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
