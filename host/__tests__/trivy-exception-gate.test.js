import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { validateTrivyResult } from '../../scripts/ci/validate-trivy-result.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'container-image.yml');

function vulnerability(overrides = {}) {
  return {
    VulnerabilityID: 'CVE-2026-56852',
    PkgName: 'golang.org/x/text',
    InstalledVersion: 'v0.38.0',
    FixedVersion: '0.39.0',
    Severity: 'HIGH',
    ...overrides,
  };
}

function report(results = [
  { Target: 'usr/bin/gh', Vulnerabilities: [vulnerability()] },
  {
    Target: 'usr/local/bin/lazygit',
    Vulnerabilities: [vulnerability({ InstalledVersion: 'v0.37.0' })],
  },
]) {
  return { Results: results };
}

describe('Trivy bounded exception gate', () => {
  it('accepts only the reviewed gh and lazygit x/text findings', () => {
    assert.deepEqual(validateTrivyResult(report()), {
      accepted: ['usr/bin/gh@v0.38.0', 'usr/local/bin/lazygit@v0.37.0'],
    });
  });

  it('rejects the CVE in any additional image target', () => {
    const input = report([
      ...report().Results,
      { Target: 'opt/other/tool', Vulnerabilities: [vulnerability()] },
    ]);
    assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding.*opt\/other\/tool/s);
  });

  it('rejects missing or installed-version-drifted reviewed findings', () => {
    assert.throws(() => validateTrivyResult(report([report().Results[0]])), /missing reviewed finding.*lazygit/s);
    assert.throws(
      () => validateTrivyResult(report([
        { Target: 'usr/bin/gh', Vulnerabilities: [vulnerability({ InstalledVersion: 'v0.39.0' })] },
        report().Results[1],
      ])),
      /unexpected HIGH\/CRITICAL finding.*v0\.39\.0/s,
    );
  });

  it('rejects duplicate findings and fixed-version or severity drift', () => {
    const cases = [
      report([
        { Target: 'usr/bin/gh', Vulnerabilities: [vulnerability(), vulnerability()] },
        report().Results[1],
      ]),
      report([
        { Target: 'usr/bin/gh', Vulnerabilities: [vulnerability({ FixedVersion: '0.39.1' })] },
        report().Results[1],
      ]),
      report([
        { Target: 'usr/bin/gh', Vulnerabilities: [vulnerability({ Severity: 'CRITICAL' })] },
        report().Results[1],
      ]),
    ];

    for (const input of cases) {
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('rejects target, vulnerability-ID, or package drift independently', () => {
    const cases = [
      report([
        { Target: 'usr/bin/other', Vulnerabilities: [vulnerability()] },
        report().Results[1],
      ]),
      report([
        { Target: 'usr/bin/gh', Vulnerabilities: [vulnerability({ VulnerabilityID: 'CVE-2099-0001' })] },
        report().Results[1],
      ]),
      report([
        { Target: 'usr/bin/gh', Vulnerabilities: [vulnerability({ PkgName: 'other' })] },
        report().Results[1],
      ]),
    ];

    for (const input of cases) {
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('rejects every unrelated HIGH or CRITICAL finding', () => {
    const input = report([
      ...report().Results,
      {
        Target: 'usr/bin/other',
        Vulnerabilities: [vulnerability({ VulnerabilityID: 'CVE-2099-0001', PkgName: 'other' })],
      },
    ]);
    assert.throws(() => validateTrivyResult(input), /CVE-2099-0001/);
  });

  it('fails closed on malformed or incomplete scanner output', () => {
    assert.throws(() => validateTrivyResult({}), /Results array/);
    assert.throws(
      () => validateTrivyResult({ Results: [{ Target: 'usr/bin/gh', Vulnerabilities: [{}] }] }),
      /malformed vulnerability/,
    );
  });

  it('wires JSON scan evidence immediately into the behavioral gate', () => {
    const workflow = parseYaml(readFileSync(WORKFLOW, 'utf8'));
    const steps = workflow.jobs.image.steps;
    const scanIndex = steps.findIndex((step) => step.name === 'Scan container image for vulnerabilities');
    const scan = steps[scanIndex];
    const gateIndex = scanIndex + 1;
    const gate = steps[gateIndex];
    const pushIndex = steps.findIndex((step) => step.name === 'Push image');
    const push = steps[pushIndex];

    assert.equal(scan.with.format, 'json');
    assert.equal(scan.with.output, '/tmp/trivy-result.json');
    assert.equal(scan.with['exit-code'], 0);
    assert.equal(scan.with.trivyignores, '.trivyignore');
    assert.equal(gate.name, 'Enforce vulnerability scan and bounded exceptions');
    assert.equal(gate.run, 'node scripts/ci/validate-trivy-result.mjs /tmp/trivy-result.json');
    assert.ok(gateIndex < pushIndex, 'the fail-closed gate must run before image push');
    assert.equal(gate.if, scan.if);
    assert.equal(push.if, gate.if);
    assert.equal(scan['continue-on-error'], undefined);
    assert.equal(gate['continue-on-error'], undefined);
    assert.equal(push['continue-on-error'], undefined);
  });
});
