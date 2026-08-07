import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { validateTrivyResult } from '../../scripts/ci/validate-trivy-result.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'container-image.yml');
const VALIDATOR = join(ROOT, 'scripts', 'ci', 'validate-trivy-result.mjs');
const DOCKERFILE = join(ROOT, 'Dockerfile');

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

function ipAddressVulnerability(installedVersion, overrides = {}) {
  return {
    VulnerabilityID: 'CVE-2026-69192',
    PkgName: 'ip-address',
    InstalledVersion: installedVersion,
    FixedVersion: '10.3.1',
    Severity: 'HIGH',
    ...overrides,
  };
}

function undiciVulnerability(installedVersion, overrides = {}) {
  return {
    VulnerabilityID: 'CVE-2026-13697',
    PkgName: 'undici',
    InstalledVersion: installedVersion,
    FixedVersion: '7.29.0, 8.9.0',
    Severity: 'HIGH',
    ...overrides,
  };
}

function report(results = [
  {
    Target: 'Node.js',
    Vulnerabilities: [
      braceExpansionVulnerability({
        PkgPath: 'usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/brace-expansion@5.0.5' },
      }),
      braceExpansionVulnerability({
        InstalledVersion: '5.0.7',
        PkgPath: 'opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/brace-expansion@5.0.7' },
      }),
      braceExpansionVulnerability({
        InstalledVersion: '5.0.7',
        PkgPath: 'opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/brace-expansion@5.0.7' },
      }),
      ipAddressVulnerability('10.1.0', {
        PkgPath: 'usr/local/lib/node_modules/npm/node_modules/ip-address/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/ip-address@10.1.0' },
      }),
      ipAddressVulnerability('10.2.0', {
        PkgPath: 'opt/code-server/lib/vscode/node_modules/ip-address/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/ip-address@10.2.0' },
      }),
      ipAddressVulnerability('10.2.0', {
        PkgPath: 'opt/code-server/node_modules/ip-address/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/ip-address@10.2.0' },
      }),
      undiciVulnerability('7.28.0', {
        PkgPath: 'opt/code-server/lib/vscode/node_modules/undici/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/undici@7.28.0' },
      }),
      undiciVulnerability('8.5.0', {
        PkgPath: 'opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/undici@8.5.0' },
      }),
      undiciVulnerability('8.5.0', {
        PkgPath: 'opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/undici@8.5.0' },
      }),
    ],
  },
]) {
  return { Results: results };
}

describe('Trivy bounded exception gate', () => {
  it('accepts only the reviewed HIGH/CRITICAL findings', () => {
    const result = validateTrivyResult(report());
    assert.deepEqual(result.accepted, [
      'Node.js@5.0.5',
      'Node.js@5.0.7',
      'Node.js@10.1.0',
      'Node.js@10.2.0',
      'Node.js@7.28.0',
      'Node.js@8.5.0',
    ]);
    assert.equal(result.evidence.length, 9);
  });

  it('reports scanner package identities for accepted reviewed findings', () => {
    assert.ok(validateTrivyResult(report()).evidence.includes(
      'CVE-2026-69192 ip-address 10.1.0 at Node.js '
      + '[path=usr/local/lib/node_modules/npm/node_modules/ip-address/package.json; '
      + 'purl=pkg:npm/ip-address@10.1.0]',
    ));
  });

  it('emits scanner identities for every accepted occurrence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trivy-gate-'));
    try {
      const input = report();
      const reportPath = join(directory, 'report.json');
      writeFileSync(reportPath, JSON.stringify(input));

      const output = execFileSync(process.execPath, [VALIDATOR, reportPath], { encoding: 'utf8' });
      const identities = output.split('\n').filter((line) => line.startsWith('Observed reviewed Trivy identity:'));
      const prefix = 'Observed reviewed Trivy identity: ';
      assert.deepEqual(identities, [
        `${prefix}CVE-2026-69152 brace-expansion 5.0.5 at Node.js [path=usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json; purl=pkg:npm/brace-expansion@5.0.5]`,
        `${prefix}CVE-2026-69152 brace-expansion 5.0.7 at Node.js [path=opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json; purl=pkg:npm/brace-expansion@5.0.7]`,
        `${prefix}CVE-2026-69152 brace-expansion 5.0.7 at Node.js [path=opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json; purl=pkg:npm/brace-expansion@5.0.7]`,
        `${prefix}CVE-2026-69192 ip-address 10.1.0 at Node.js [path=usr/local/lib/node_modules/npm/node_modules/ip-address/package.json; purl=pkg:npm/ip-address@10.1.0]`,
        `${prefix}CVE-2026-69192 ip-address 10.2.0 at Node.js [path=opt/code-server/lib/vscode/node_modules/ip-address/package.json; purl=pkg:npm/ip-address@10.2.0]`,
        `${prefix}CVE-2026-69192 ip-address 10.2.0 at Node.js [path=opt/code-server/node_modules/ip-address/package.json; purl=pkg:npm/ip-address@10.2.0]`,
        `${prefix}CVE-2026-13697 undici 7.28.0 at Node.js [path=opt/code-server/lib/vscode/node_modules/undici/package.json; purl=pkg:npm/undici@7.28.0]`,
        `${prefix}CVE-2026-13697 undici 8.5.0 at Node.js [path=opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json; purl=pkg:npm/undici@8.5.0]`,
        `${prefix}CVE-2026-13697 undici 8.5.0 at Node.js [path=opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json; purl=pkg:npm/undici@8.5.0]`,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects retired gh and lazygit x/text findings', () => {
    for (const target of ['usr/bin/gh', 'usr/local/bin/lazygit']) {
      const input = report([
        {
          Target: target,
          Vulnerabilities: [vulnerability({
            InstalledVersion: 'v0.37.0',
            PkgIdentifier: { PURL: 'pkg:golang/golang.org/x/text@v0.37.0' },
          })],
        },
        ...report().Results,
      ]);
      assert.throws(() => validateTrivyResult(input), new RegExp(`unexpected HIGH/CRITICAL finding.*${target}`, 's'));
    }
  });

  it('rejects duplicate reviewed findings', () => {
    const input = report();
    input.Results[0].Vulnerabilities.push(structuredClone(input.Results[0].Vulnerabilities[0]));
    assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
  });

  it('rejects p7zip RCE findings and keeps the vulnerable preview package out of the image', () => {
    assert.doesNotMatch(readFileSync(DOCKERFILE, 'utf8'), /\bp7zip(?:-full)?\b/);
    const input = report([
      ...report().Results,
      {
        Target: 'codeflare-integration-container:in-2cff5a5fadebd9a6 (debian 12.15)',
        Vulnerabilities: [{
          VulnerabilityID: 'CVE-2026-14266',
          PkgName: 'p7zip-full',
          InstalledVersion: '16.02+really26.01+dfsg-0+deb12u1',
          FixedVersion: '16.02+really26.02+dfsg-0+deb12u1',
          Severity: 'HIGH',
        }],
      },
    ]);
    assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
  });

  it('rejects vulnerability-ID or package drift independently', () => {
    for (const change of [
      { VulnerabilityID: 'CVE-2099-0001' },
      { PkgName: 'other' },
    ]) {
      const input = report();
      Object.assign(input.Results[0].Vulnerabilities[0], change);
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('rejects package-path or PURL drift from a reviewed identity', () => {
    for (const change of [
      { PkgPath: 'other/package.json' },
      { PkgIdentifier: { PURL: 'pkg:npm/ip-address@10.1.0?other' } },
    ]) {
      const input = report();
      const reviewed = input.Results[0].Vulnerabilities.find(
        (finding) => finding.PkgName === 'ip-address' && finding.InstalledVersion === '10.1.0',
      );
      Object.assign(reviewed, change);
      assert.throws(
        () => validateTrivyResult(input),
        /unexpected HIGH\/CRITICAL finding.*missing reviewed finding/s,
      );
    }
  });

  it('rejects missing occurrences from the reviewed deployment tuples', () => {
    const nodeResult = structuredClone(report().Results[0]);
    nodeResult.Vulnerabilities.splice(
      nodeResult.Vulnerabilities.findIndex((finding) => finding.PkgName === 'ip-address' && finding.InstalledVersion === '10.2.0'),
      1,
    );
    assert.throws(
      () => validateTrivyResult(report([nodeResult])),
      /missing reviewed finding.*ip-address 10\.2\.0.*path=opt\/code-server\/lib\/vscode\/node_modules\/ip-address\/package\.json; purl=pkg:npm\/ip-address@10\.2\.0/s,
    );
  });

  it('rejects a missing reviewed Node.js finding', () => {
    assert.throws(
      () => validateTrivyResult(report([
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
        () => validateTrivyResult(report([changed])),
        /unexpected HIGH\/CRITICAL finding/,
      );
    }
  });

  it('reports every unexpected and missing finding together', () => {
    const input = report([
      { Target: 'Node.js', Vulnerabilities: [braceExpansionVulnerability()] },
      {
        Target: 'usr/bin/other',
        Vulnerabilities: [
          vulnerability({
            VulnerabilityID: 'CVE-2099-0001',
            PkgName: 'first',
            PkgPath: 'opt/first/package.json',
            PkgIdentifier: { PURL: 'pkg:npm/first@1.0.0' },
          }),
          vulnerability({ VulnerabilityID: 'CVE-2099-0002', PkgName: 'second', PkgPath: 'opt/second/package.json' }),
        ],
      },
    ]);
    assert.throws(
      () => validateTrivyResult(input),
      (error) => error.message.includes('CVE-2099-0001')
        && error.message.includes('path=opt/first/package.json')
        && error.message.includes('purl=pkg:npm/first@1.0.0')
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
