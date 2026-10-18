import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateTrivyResult } from '../../scripts/ci/validate-trivy-result.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VALIDATOR = join(ROOT, 'scripts', 'ci', 'validate-trivy-result.mjs');

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
    InstalledVersion: '5.0.7',
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

function basicFtpVulnerability(overrides = {}) {
  return {
    VulnerabilityID: 'CVE-2026-102990', PkgName: 'basic-ftp',
    InstalledVersion: '5.3.1', FixedVersion: '6.2.1', Severity: 'HIGH',
    PkgPath: 'opt/code-server/node_modules/basic-ftp/package.json',
    PkgIdentifier: { PURL: 'pkg:npm/basic-ftp@5.3.1' },
    ...overrides,
  };
}

function report(results = [{ Target: 'Node.js', Vulnerabilities: [] }]) {
  return { Results: results };
}

describe('REQ-SEC-011 + REQ-OPS-002: Trivy bounded exception gate', () => {
  it('accepts a patched image without the retired basic-ftp finding', () => {
    assert.deepEqual(validateTrivyResult(report()), { accepted: [], evidence: [] });
  });

  it('rejects recurrence of the retired basic-ftp finding with scanner identities', () => {
    const input = report();
    input.Results[0].Vulnerabilities.push(basicFtpVulnerability());
    assert.throws(() => validateTrivyResult(input),
      /unexpected HIGH\/CRITICAL finding: CVE-2026-102990 basic-ftp 5\.3\.1.*path=opt\/code-server\/node_modules\/basic-ftp\/package\.json; purl=pkg:npm\/basic-ftp@5\.3\.1/);
  });

  it('REQ-SEC-011 AC7: emits scanner path and PURL for every accepted fixture occurrence', () => {
    // Controlled policy fixture only: production has no active exceptions.
    const first = {
      vulnerabilityId: 'CVE-2099-0001', packageName: 'reviewed-fixture', target: 'Node.js',
      packagePath: 'fixtures/first/package.json', packagePurl: 'pkg:npm/reviewed-fixture@1.0.0',
      installedVersion: '1.0.0', fixedVersion: '1.0.1', severity: 'HIGH', occurrences: 2,
    };
    const second = { ...first, packagePath: 'fixtures/second/package.json', occurrences: 1 };
    const policy = [first, second];
    const occurrence = reviewed => ({ VulnerabilityID: reviewed.vulnerabilityId,
      PkgName: reviewed.packageName, InstalledVersion: reviewed.installedVersion,
      FixedVersion: reviewed.fixedVersion, Severity: reviewed.severity,
      PkgPath: reviewed.packagePath, PkgIdentifier: { PURL: reviewed.packagePurl } });
    const input = report([{ Target: 'Node.js',
      Vulnerabilities: [occurrence(first), occurrence(second), occurrence(first)] }]);
    const directory = mkdtempSync(join(tmpdir(), 'trivy-reviewed-fixture-'));
    try {
      const reportPath = join(directory, 'report.json');
      writeFileSync(reportPath, JSON.stringify(input));
      // Run the real validation/output entrypoint with a controlled in-process
      // fixture. The production CLI has no policy flag or environment override.
      const script = `import { main } from ${JSON.stringify(pathToFileURL(VALIDATOR).href)};`
        + `await main(${JSON.stringify(reportPath)}, ${JSON.stringify(policy)});`;
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      const identities = output.split('\n').filter(line => line.startsWith('Observed reviewed Trivy identity:'));
      assert.deepEqual(identities, [first, second, first].map(reviewed =>
        `Observed reviewed Trivy identity: ${reviewed.vulnerabilityId} ${reviewed.packageName} `
        + `${reviewed.installedVersion} at ${reviewed.target} `
        + `[path=${reviewed.packagePath}; purl=${reviewed.packagePurl}]`));
      // The fixture cannot broaden policy, omit occurrences or accept duplicates.
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
      const changed = structuredClone(input);
      changed.Results[0].Vulnerabilities[1].PkgIdentifier.PURL += '?drift';
      assert.throws(() => validateTrivyResult(changed, policy), /unexpected HIGH\/CRITICAL finding/);
      const missing = structuredClone(input);
      missing.Results[0].Vulnerabilities.pop();
      assert.throws(() => validateTrivyResult(missing, policy), /missing reviewed finding/);
      const duplicate = structuredClone(input);
      duplicate.Results[0].Vulnerabilities.push(occurrence(first));
      assert.throws(() => validateTrivyResult(duplicate, policy), /unexpected HIGH\/CRITICAL finding/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('emits no accepted identities for an exception-free image', () => {
    const directory = mkdtempSync(join(tmpdir(), 'trivy-gate-'));
    try {
      const input = report();
      const reportPath = join(directory, 'report.json');
      writeFileSync(reportPath, JSON.stringify(input));

      const output = execFileSync(process.execPath, [VALIDATOR, reportPath], { encoding: 'utf8' });
      const identities = output.split('\n').filter((line) => line.startsWith('Observed reviewed Trivy identity:'));
      assert.deepEqual(identities, []);
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

  it('rejects retired Pi findings after the runtime upgrade', () => {
    const piRoots = [
      'opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/node_modules',
      'opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent/node_modules',
    ];
    const retiredFindings = piRoots.flatMap((root) => [
      braceExpansionVulnerability({
        InstalledVersion: '5.0.7',
        PkgPath: `${root}/brace-expansion/package.json`,
        PkgIdentifier: { PURL: 'pkg:npm/brace-expansion@5.0.7' },
      }),
      undiciVulnerability('8.5.0', {
        PkgPath: `${root}/undici/package.json`,
        PkgIdentifier: { PURL: 'pkg:npm/undici@8.5.0' },
      }),
    ]);
    for (const finding of retiredFindings) {
      const input = report();
      input.Results[0].Vulnerabilities.push(finding);
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('rejects retired code-server findings after the Code upgrade', () => {
    const retiredFindings = [
      ipAddressVulnerability('10.2.0', {
        PkgPath: 'opt/code-server/lib/vscode/node_modules/ip-address/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/ip-address@10.2.0' },
      }),
      undiciVulnerability('7.28.0', {
        PkgPath: 'opt/code-server/lib/vscode/node_modules/undici/package.json',
        PkgIdentifier: { PURL: 'pkg:npm/undici@7.28.0' },
      }),
    ];
    for (const finding of retiredFindings) {
      const input = report();
      input.Results[0].Vulnerabilities.push(finding);
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('rejects superseded basic-ftp identities', () => {
    const input = report();
    input.Results[0].Vulnerabilities.push(basicFtpVulnerability({
      InstalledVersion: '5.3.0',
      PkgIdentifier: { PURL: 'pkg:npm/basic-ftp@5.3.0' },
    }));
    assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
  });

  it('rejects recurrence of the retired npm ip-address finding', () => {
    const input = report();
    input.Results[0].Vulnerabilities.push(ipAddressVulnerability('10.2.0', {
      PkgPath: 'usr/local/lib/node_modules/npm/node_modules/ip-address/package.json',
      PkgIdentifier: { PURL: 'pkg:npm/ip-address@10.2.0' },
    }));
    assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding.*CVE-2026-69192/s);
  });

  it('rejects duplicate unexcepted findings', () => {
    const input = report();
    input.Results[0].Vulnerabilities.push(basicFtpVulnerability(), basicFtpVulnerability());
    assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
  });

  it('rejects p7zip RCE findings without a reviewed exception', () => {
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
      input.Results[0].Vulnerabilities.push(basicFtpVulnerability(change));
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('rejects basic-ftp findings at other paths or PURLs', () => {
    for (const change of [
      { PkgPath: 'other/package.json' },
      { PkgIdentifier: { PURL: 'pkg:npm/basic-ftp@5.3.1?other' } },
    ]) {
      const input = report();
      input.Results[0].Vulnerabilities.push(basicFtpVulnerability(change));
      assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding/);
    }
  });

  it('accepts a patched image without the retired npm brace finding', () => {
    assert.doesNotThrow(() => validateTrivyResult(report()));
  });

  it('rejects recurrence of the retired npm brace vulnerability', () => {
    const input = report();
    input.Results[0].Vulnerabilities.push(braceExpansionVulnerability({
      PkgPath: 'usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json',
      PkgIdentifier: { PURL: 'pkg:npm/brace-expansion@5.0.7' },
    }));
    assert.throws(() => validateTrivyResult(input), /unexpected HIGH\/CRITICAL finding.*CVE-2026-69152/s);
  });

  it('rejects basic-ftp findings with other target, version or severity identities', () => {
    for (const change of [
      { target: 'other' },
      { InstalledVersion: '5.3.0' },
      { FixedVersion: '6.2.2' },
      { Severity: 'CRITICAL' },
    ]) {
      const input = report();
      input.Results[0].Vulnerabilities.push(basicFtpVulnerability());
      if (change.target) input.Results[0].Target = change.target;
      else Object.assign(input.Results[0].Vulnerabilities[0], change);
      assert.throws(
        () => validateTrivyResult(input),
        /unexpected HIGH\/CRITICAL finding/,
      );
    }
  });

  it('reports every unexpected finding together', () => {
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
        && error.message.includes('path=opt/second/package.json'),
    );
  });

  it('fails closed on malformed or incomplete scanner output', () => {
    assert.throws(() => validateTrivyResult({}), /Results array/);
    assert.throws(
      () => validateTrivyResult({ Results: [{ Target: 'usr/bin/gh', Vulnerabilities: [{}] }] }),
      /malformed vulnerability/,
    );
  });

});
