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

function braceExpansionVulnerability(overrides = {}) {
  return {
    VulnerabilityID: 'CVE-2026-69152',
    PkgName: 'brace-expansion',
    InstalledVersion: '5.0.5',
    FixedVersion: '1.1.18, 2.1.4, 3.0.6, 5.0.9',
    Severity: 'HIGH',
    ...overrides,
  };
}

function ipAddressVulnerability(installedVersion) {
  return {
    VulnerabilityID: 'CVE-2026-69192',
    PkgName: 'ip-address',
    InstalledVersion: installedVersion,
    FixedVersion: '10.3.1',
    Severity: 'HIGH',
  };
}

function undiciVulnerability(installedVersion) {
  return {
    VulnerabilityID: 'CVE-2026-13697',
    PkgName: 'undici',
    InstalledVersion: installedVersion,
    FixedVersion: '7.29.0, 8.9.0',
    Severity: 'HIGH',
  };
}

function report(results = [
  {
    Target: 'usr/local/bin/lazygit',
    Vulnerabilities: [vulnerability({ InstalledVersion: 'v0.37.0' })],
  },
  {
    Target: 'Node.js',
    Vulnerabilities: [
      braceExpansionVulnerability(),
      braceExpansionVulnerability({ InstalledVersion: '5.0.7' }),
      braceExpansionVulnerability({ InstalledVersion: '5.0.7' }),
      ipAddressVulnerability('10.1.0'),
      ipAddressVulnerability('10.2.0'),
      ipAddressVulnerability('10.2.0'),
      undiciVulnerability('7.28.0'),
      undiciVulnerability('8.5.0'),
      undiciVulnerability('8.5.0'),
    ],
  },
]) {
  return { Results: results };
}

describe('Trivy bounded exception gate', () => {
  it('accepts only the reviewed lazygit and Node.js findings', () => {
    assert.deepEqual(validateTrivyResult(report()), {
      accepted: [
        'usr/local/bin/lazygit@v0.37.0',
        'Node.js@5.0.5',
        'Node.js@5.0.7',
        'Node.js@10.1.0',
        'Node.js@10.2.0',
        'Node.js@7.28.0',
        'Node.js@8.5.0',
      ],
    });
  });

  it('rejects the retired gh x/text finding', () => {
    const input = report([
      { Target: 'usr/bin/gh', Vulnerabilities: [vulnerability()] },
      ...report().Results,
    ]);
    assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding.*usr\/bin\/gh/s);
  });

  it('rejects a missing or installed-version-drifted reviewed finding', () => {
    assert.throws(() => validateTrivyResult(report([])), /missing reviewed finding.*lazygit/s);
    assert.throws(
      () => validateTrivyResult(report([{
        Target: 'usr/local/bin/lazygit',
        Vulnerabilities: [vulnerability({ InstalledVersion: 'v0.38.0' })],
      }])),
      /unexpected HIGH\/CRITICAL finding.*v0\.38\.0/s,
    );
  });

  it('rejects duplicate findings and fixed-version or severity drift', () => {
    const cases = [
      report([{
        Target: 'usr/local/bin/lazygit',
        Vulnerabilities: [
          vulnerability({ InstalledVersion: 'v0.37.0' }),
          vulnerability({ InstalledVersion: 'v0.37.0' }),
        ],
      }]),
      report([{
        Target: 'usr/local/bin/lazygit',
        Vulnerabilities: [vulnerability({ InstalledVersion: 'v0.37.0', FixedVersion: '0.39.1' })],
      }]),
      report([{
        Target: 'usr/local/bin/lazygit',
        Vulnerabilities: [vulnerability({ InstalledVersion: 'v0.37.0', Severity: 'CRITICAL' })],
      }]),
    ];
    for (const input of cases) {
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('rejects target, vulnerability-ID, or package drift independently', () => {
    const cases = [
      { Target: 'usr/bin/other', Vulnerabilities: [vulnerability({ InstalledVersion: 'v0.37.0' })] },
      {
        Target: 'usr/local/bin/lazygit',
        Vulnerabilities: [vulnerability({ VulnerabilityID: 'CVE-2099-0001', InstalledVersion: 'v0.37.0' })],
      },
      {
        Target: 'usr/local/bin/lazygit',
        Vulnerabilities: [vulnerability({ PkgName: 'other', InstalledVersion: 'v0.37.0' })],
      },
    ];
    for (const result of cases) {
      assert.throws(() => validateTrivyResult(report([result])), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('rejects missing occurrences from the reviewed deployment tuples', () => {
    const nodeResult = structuredClone(report().Results[1]);
    nodeResult.Vulnerabilities.splice(
      nodeResult.Vulnerabilities.findIndex((finding) => finding.PkgName === 'ip-address' && finding.InstalledVersion === '10.2.0'),
      1,
    );
    assert.throws(
      () => validateTrivyResult(report([report().Results[0], nodeResult])),
      /missing reviewed finding.*ip-address 10\.2\.0/s,
    );
  });

  it('rejects a missing reviewed Node.js finding', () => {
    assert.throws(
      () => validateTrivyResult(report([
        report().Results[0],
        {
          Target: 'Node.js',
          Vulnerabilities: [
            braceExpansionVulnerability(),
            braceExpansionVulnerability({ InstalledVersion: '5.0.7' }),
          ],
        },
      ])),
      /missing reviewed finding.*5\.0\.7/s,
    );
  });

  it('rejects drift in the reviewed Node.js finding', () => {
    const cases = [
      { Target: 'other', Vulnerabilities: [braceExpansionVulnerability()] },
      { Target: 'Node.js', Vulnerabilities: [braceExpansionVulnerability({ InstalledVersion: '5.0.6' })] },
      { Target: 'Node.js', Vulnerabilities: [braceExpansionVulnerability({ FixedVersion: '5.0.9' })] },
      { Target: 'Node.js', Vulnerabilities: [braceExpansionVulnerability({ Severity: 'CRITICAL' })] },
    ];
    for (const changed of cases) {
      assert.throws(
        () => validateTrivyResult(report([report().Results[0], changed])),
        /unexpected HIGH\/CRITICAL finding/,
      );
    }
  });

  it('reports every unexpected and missing finding together', () => {
    const input = report([
      report().Results[0],
      { Target: 'Node.js', Vulnerabilities: [braceExpansionVulnerability()] },
      {
        Target: 'usr/bin/other',
        Vulnerabilities: [
          vulnerability({ VulnerabilityID: 'CVE-2099-0001', PkgName: 'first', PkgPath: 'opt/first/package.json' }),
          vulnerability({ VulnerabilityID: 'CVE-2099-0002', PkgName: 'second', PkgPath: 'opt/second/package.json' }),
        ],
      },
    ]);
    assert.throws(
      () => validateTrivyResult(input),
      (error) => error.message.includes('CVE-2099-0001')
        && error.message.includes('path=opt/first/package.json')
        && error.message.includes('CVE-2099-0002')
        && error.message.includes('path=opt/second/package.json')
        && error.message.includes('missing reviewed finding: CVE-2026-69152 brace-expansion 5.0.7'),
    );
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
    assert.equal(scan.with['ignore-unfixed'], true);
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
