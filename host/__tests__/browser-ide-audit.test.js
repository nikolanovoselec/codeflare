import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { assessBrowserIdeAudit } from '../../scripts/ci/check-browser-ide-audit.mjs';

const ghsa = 'GHSA-fc5q-39xc-vjpf';
const withdrawnAt = '2026-11-18T15:38:56Z';
const advisory = () => ({
  ghsa_id: ghsa,
  withdrawn_at: withdrawnAt,
  vulnerabilities: [{ package: { ecosystem: 'npm', name: 'picomatch' }, vulnerable_version_range: '<= 4.0.7' }],
});
const readAdvisory = async () => advisory();
const cause = (name = 'picomatch', severity = 'high', id = ghsa) => ({
  source: 1247710, name, dependency: name, title: 'ReDoS',
  url: `https://github.com/advisories/${id}`, severity, range: '<=4.0.7',
});
const finding = (name, via, severity = 'high') => ({
  name, severity, isDirect: name === 'vitest' || name === '@vitest/coverage-v8', via,
  effects: [], range: '*', nodes: [`node_modules/${name}`], fixAvailable: false,
});
function report(vulnerabilities = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const entry of Object.values(vulnerabilities)) {
    counts[entry.severity] += 1;
    counts.total += 1;
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts } };
}
function sixFindings() {
  const output = report({
    '@vitest/coverage-v8': finding('@vitest/coverage-v8', ['vitest']),
    fdir: finding('fdir', ['picomatch']),
    picomatch: finding('picomatch', [cause()]),
    tinyglobby: finding('tinyglobby', ['fdir', 'picomatch']),
    vite: finding('vite', ['picomatch', 'tinyglobby']),
    vitest: finding('vitest', ['@vitest/coverage-v8', 'picomatch', 'tinyglobby', 'vite']),
  });
  Object.assign(output.vulnerabilities.picomatch, { effects: ['fdir', 'tinyglobby', 'vite', 'vitest'] });
  output.vulnerabilities.fdir.effects = ['tinyglobby'];
  output.vulnerabilities.tinyglobby.effects = ['vite', 'vitest'];
  output.vulnerabilities.vite.effects = ['vitest'];
  output.vulnerabilities.vitest.effects = ['@vitest/coverage-v8'];
  output.vulnerabilities['@vitest/coverage-v8'].effects = ['vitest'];
  return output;
}

describe('Browser IDE npm audit: verified withdrawn advisory exception', () => {
  it('accepts a clean npm success without requiring advisory availability', async () => {
    const result = await assessBrowserIdeAudit(report(), 0, async () => { throw new Error('offline'); });
    assert.deepEqual(result.withdrawnFindings, []);
  });

  it('preserves --audit-level=high for normal successes with lower-severity findings', async () => {
    const output = report({ other: finding('other', [cause('other', 'moderate', 'GHSA-xxxx-yyyy-zzzz')], 'moderate') });
    assert.deepEqual((await assessBrowserIdeAudit(output, 0, readAdvisory)).withdrawnFindings, []);
  });

  it('accepts the actual six-finding dependency chain with the vitest/coverage cycle', async () => {
    const result = await assessBrowserIdeAudit(sixFindings(), 1, readAdvisory);
    assert.deepEqual(result, {
      withdrawnFindings: ['@vitest/coverage-v8', 'fdir', 'picomatch', 'tinyglobby', 'vite', 'vitest'],
      advisory: ghsa, withdrawnAt,
    });
  });

  it('allows unrelated lower-severity findings outside the blocking cause graph', async () => {
    const output = sixFindings();
    output.vulnerabilities.other = finding('other', [cause('other', 'low', 'GHSA-xxxx-yyyy-zzzz')], 'low');
    const result = await assessBrowserIdeAudit(report(output.vulnerabilities), 1, readAdvisory);
    assert.equal(result.withdrawnFindings.length, 6);
    assert.ok(!result.withdrawnFindings.includes('other'));
  });

  for (const severity of ['high', 'critical']) {
    it(`rejects an unrelated active ${severity} finding alongside the withdrawn chain`, async () => {
      const output = sixFindings();
      output.vulnerabilities.other = finding('other', [cause('other', severity, 'GHSA-xxxx-yyyy-zzzz')], severity);
      await assert.rejects(assessBrowserIdeAudit(report(output.vulnerabilities), 1, readAdvisory), /unapproved advisory/);
    });
  }

  it('rejects a second advisory on picomatch, including a lower-severity cause', async () => {
    const output = sixFindings();
    output.vulnerabilities.picomatch.via.push(cause('picomatch', 'moderate', 'GHSA-xxxx-yyyy-zzzz'));
    await assert.rejects(assessBrowserIdeAudit(output, 1, readAdvisory), /unapproved advisory/);
  });

  it('rejects an active cause hidden behind the coverage cycle', async () => {
    const output = sixFindings();
    output.vulnerabilities['@vitest/coverage-v8'].via.push(cause('@vitest/coverage-v8', 'high', 'GHSA-xxxx-yyyy-zzzz'));
    await assert.rejects(assessBrowserIdeAudit(output, 1, readAdvisory), /unapproved advisory/);
  });

  it('rejects a disconnected cycle that cannot reach any direct advisory', async () => {
    const output = report({ a: finding('a', ['b']), b: finding('b', ['a']) });
    await assert.rejects(assessBrowserIdeAudit(output, 1, readAdvisory), /Ungrounded/);
  });

  it('rejects an ungrounded cause cycle even when its dependent also reaches picomatch', async () => {
    const output = sixFindings();
    output.vulnerabilities.a = finding('a', ['b']);
    output.vulnerabilities.b = finding('b', ['a']);
    output.vulnerabilities.vitest.via.push('a');
    await assert.rejects(assessBrowserIdeAudit(report(output.vulnerabilities), 1, readAdvisory), /Ungrounded/);
  });

  for (const mutate of [
    entry => { entry.withdrawn_at = null; },
    entry => { delete entry.withdrawn_at; },
    entry => { entry.withdrawn_at = ''; },
    entry => { entry.withdrawn_at = 'not-a-date'; },
    entry => { entry.ghsa_id = 'GHSA-xxxx-yyyy-zzzz'; },
    entry => { entry.vulnerabilities[0].package.name = 'other'; },
    entry => { entry.vulnerabilities[0].package.ecosystem = 'pip'; },
    entry => { entry.vulnerabilities = []; },
  ]) {
    it('rejects active, reactivated, unknown or malformed GitHub advisory evidence', async () => {
      const entry = advisory();
      mutate(entry);
      await assert.rejects(assessBrowserIdeAudit(sixFindings(), 1, async () => entry), /did not confirm/);
    });
  }

  for (const value of [null, [], {}, 'invalid JSON response', { error: 'Not Found' }]) {
    it('rejects a malformed or unknown advisory lookup response', async () => {
      await assert.rejects(assessBrowserIdeAudit(sixFindings(), 1, async () => value), /did not confirm/);
    });
  }

  it('fails closed when the advisory is reactivated after a previously accepted assessment', async () => {
    assert.equal((await assessBrowserIdeAudit(sixFindings(), 1, readAdvisory)).advisory, ghsa);
    await assert.rejects(assessBrowserIdeAudit(sixFindings(), 1, async () => ({ ...advisory(), withdrawn_at: null })), /did not confirm/);
  });

  for (const message of ['request timed out', 'invalid JSON', 'secret transport configuration']) {
    it('fails closed with a sanitized diagnostic on lookup failure', async () => {
      await assert.rejects(assessBrowserIdeAudit(sixFindings(), 1, async () => { throw new Error(message); }),
        error => error.message === 'Unable to verify advisory withdrawal with GitHub');
    });
  }

  for (const mutate of [
    output => { output.error = { code: 'E503', summary: 'registry unavailable' }; },
    output => { output.auditReportVersion = 1; },
    output => { output.vulnerabilities = []; },
    output => { delete output.metadata; },
    output => { output.metadata.vulnerabilities.high = 0; },
    output => { output.metadata.vulnerabilities.total = 0; },
    output => { output.vulnerabilities.picomatch.name = 'other'; },
    output => { output.vulnerabilities.picomatch.severity = 'unknown'; },
    output => { output.vulnerabilities.picomatch.via = []; },
    output => { output.vulnerabilities.picomatch.via = [null]; },
    output => { output.vulnerabilities.picomatch.via = [{}]; },
    output => { output.vulnerabilities.picomatch.via = ['missing']; },
    output => { output.vulnerabilities.picomatch.via[0].dependency = ''; },
    output => { output.vulnerabilities.picomatch.via[0].url = ''; },
    output => { output.vulnerabilities.picomatch.via[0].severity = 'unknown'; },
  ]) {
    it('rejects malformed, inconsistent, registry-error or dangling report data', async () => {
      const output = sixFindings();
      mutate(output);
      await assert.rejects(assessBrowserIdeAudit(output, 1, readAdvisory));
    });
  }

  it('rejects advisory identity spoofing by another package or URL', async () => {
    const output = report({ other: finding('other', [cause('other')]) });
    await assert.rejects(assessBrowserIdeAudit(output, 1, readAdvisory), /unapproved advisory/);
    const spoofed = sixFindings();
    spoofed.vulnerabilities.picomatch.via[0].url += '/other';
    await assert.rejects(assessBrowserIdeAudit(spoofed, 1, readAdvisory), /unapproved advisory/);
  });

  it('rejects a report hiding a high-severity cause in a lower-severity aggregate', async () => {
    const output = report({ other: finding('other', [cause('other')], 'low') });
    await assert.rejects(assessBrowserIdeAudit(output, 0, readAdvisory), /cause severity/);
  });

  for (const code of [-1, 2, 127, null, '0', '1']) {
    it(`rejects unsupported original npm exit code ${JSON.stringify(code)}`, async () => {
      await assert.rejects(assessBrowserIdeAudit(report(), code, readAdvisory), /Unsupported/);
    });
  }

  it('rejects contradictory success/failure status rather than excusing npm execution errors', async () => {
    await assert.rejects(assessBrowserIdeAudit(sixFindings(), 0, readAdvisory), /exit code/);
    await assert.rejects(assessBrowserIdeAudit(report(), 1, readAdvisory), /exit code/);
  });

  it('exposes CLI success, invalid JSON, missing file and unsupported-status outcomes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-ide-audit-'));
    const path = join(directory, 'audit.json');
    const script = fileURLToPath(new URL('../../scripts/ci/check-browser-ide-audit.mjs', import.meta.url));
    const run = (...args) => promisify(execFile)(process.execPath, [script, ...args], { timeout: 5000 });
    try {
      await writeFile(path, JSON.stringify(report()));
      assert.match((await run(path, '0')).stdout, /passed at --audit-level=high/);
      await assert.rejects(run(path, '2'), error => error.code === 1 && /usage:/.test(error.stderr));
      await assert.rejects(run(path, '0', 'extra'), error => error.code === 1 && /usage:/.test(error.stderr));
      await writeFile(path, '{');
      await assert.rejects(run(path, '0'), error => error.code === 1 && /valid npm audit JSON/.test(error.stderr));
      await assert.rejects(run(join(directory, 'missing.json'), '0'), error => error.code === 1 && /valid npm audit JSON/.test(error.stderr));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
