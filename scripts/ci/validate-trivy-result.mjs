#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REVIEWED_FINDINGS = [
  {
    // Reviewed 2026-07-31 (PR #716 code lane): golang.org/x/text advisory in
    // the vendored lazygit binary; no fixed lazygit release ships x/text
    // >= 0.39.0 yet. Remove this entry when the pinned lazygit bumps past it —
    // the gate then fails closed on the stale exception.
    target: 'usr/local/bin/lazygit',
    vulnerabilityId: 'CVE-2026-56852',
    packageName: 'golang.org/x/text',
    installedVersion: 'v0.37.0',
    fixedVersion: '0.39.0',
    severity: 'HIGH',
  },
  {
    // Reviewed from integration deployment 30847836723 at head a05cf374 and
    // image sha256:324dc992f5d65aa9ab597a382ca6d35bd0629bfd502f809369547760dd767e3f.
    // Trivy reports this package under its generic Node.js target. The DoS
    // remains confined to the authenticated user's single-tenant container.
    // Remove when the image no longer contains brace-expansion 5.0.5.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69152',
    packageName: 'brace-expansion',
    installedVersion: '5.0.5',
    fixedVersion: '1.1.18, 2.1.4, 3.0.6, 5.0.9',
    severity: 'HIGH',
  },
  {
    // Deployment 30849615814 at head a2fc364 first exposed this tuple; complete
    // scan 30850703965 at head fc9d3df and image
    // sha256:d49c09b199af57af6bc435360a4fffab86f3a4920030318ec50bbd5b03a013aa
    // proved that it occurs twice. Remove when that exact multiplicity changes.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69152',
    packageName: 'brace-expansion',
    installedVersion: '5.0.7',
    fixedVersion: '1.1.18, 2.1.4, 3.0.6, 5.0.9',
    severity: 'HIGH',
    occurrences: 2,
  },
  {
    // Integration deployments 30893082736/30893082817 at head 8a745b7 and
    // image IDs sha256:2ee1ac0/sha256:5847655 reported this stale declaration.
    // Every committed runtime lock resolves ip-address to patched 10.4.0.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69192',
    packageName: 'ip-address',
    installedVersion: '10.1.0',
    fixedVersion: '10.3.1',
    severity: 'HIGH',
  },
  {
    // The same complete scans reported two 10.2.0 declarations. The two Pi
    // runtime locks and Browser Run lock all resolve the package to 10.4.0.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69192',
    packageName: 'ip-address',
    installedVersion: '10.2.0',
    fixedVersion: '10.3.1',
    severity: 'HIGH',
    occurrences: 2,
  },
  {
    // Node/npm image tooling carries undici 7.28.0. Codeflare does not enable
    // its shared cache interceptor; use remains inside one user's container.
    // Remove when the pinned Node base image carries undici 7.29.0 or later.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-13697',
    packageName: 'undici',
    installedVersion: '7.28.0',
    fixedVersion: '7.29.0, 8.9.0',
    severity: 'HIGH',
  },
  {
    // Two upstream Pi package manifests still declare undici 8.5.0, while both
    // committed runtime locks override and install patched 8.9.0. The exact
    // scanner multiplicity remains bounded until upstream updates its metadata.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-13697',
    packageName: 'undici',
    installedVersion: '8.5.0',
    fixedVersion: '7.29.0, 8.9.0',
    severity: 'HIGH',
    occurrences: 2,
  },
];

function findingKey(finding) {
  return [
    finding.target,
    finding.vulnerabilityId,
    finding.packageName,
    finding.installedVersion,
    finding.fixedVersion,
    finding.severity,
  ].join('\u0000');
}

export function validateTrivyResult(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.Results)) {
    throw new Error('Trivy report must contain a Results array');
  }

  const expected = new Map(REVIEWED_FINDINGS.map((finding) => [
    findingKey(finding),
    { finding, occurrences: finding.occurrences ?? 1 },
  ]));
  const seen = new Map();
  const findings = [];

  for (const result of report.Results) {
    if (!result || typeof result !== 'object' || typeof result.Target !== 'string') {
      throw new Error('Trivy report contains a malformed result');
    }
    if (result.Vulnerabilities == null) continue;
    if (!Array.isArray(result.Vulnerabilities)) {
      throw new Error(`Trivy result for ${result.Target} has a malformed Vulnerabilities field`);
    }

    for (const vulnerability of result.Vulnerabilities) {
      const required = [
        vulnerability?.VulnerabilityID,
        vulnerability?.PkgName,
        vulnerability?.InstalledVersion,
        vulnerability?.FixedVersion,
        vulnerability?.Severity,
      ];
      if (required.some((value) => typeof value !== 'string' || value.length === 0)) {
        throw new Error(`Trivy report contains a malformed vulnerability for ${result.Target}`);
      }

      const finding = {
        target: result.Target,
        vulnerabilityId: vulnerability.VulnerabilityID,
        packageName: vulnerability.PkgName,
        installedVersion: vulnerability.InstalledVersion,
        fixedVersion: vulnerability.FixedVersion,
        severity: vulnerability.Severity,
      };
      const key = findingKey(finding);
      const reviewed = expected.get(key);
      const occurrences = seen.get(key) ?? 0;
      if (!reviewed || occurrences >= reviewed.occurrences) {
        findings.push(
          `unexpected HIGH/CRITICAL finding: ${finding.vulnerabilityId} ${finding.packageName} `
          + `${finding.installedVersion} -> ${finding.fixedVersion} at ${finding.target}`,
        );
      } else {
        seen.set(key, occurrences + 1);
      }
    }
  }

  for (const [key, reviewed] of expected) {
    if ((seen.get(key) ?? 0) < reviewed.occurrences) {
      const { finding } = reviewed;
      findings.push(
        `missing reviewed finding: ${finding.vulnerabilityId} ${finding.packageName} `
        + `${finding.installedVersion} at ${finding.target}; remove or re-review the exception`,
      );
    }
  }

  if (findings.length > 0) throw new Error(findings.join('\n'));

  return {
    accepted: REVIEWED_FINDINGS.map((finding) => `${finding.target}@${finding.installedVersion}`),
  };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: validate-trivy-result.mjs <trivy-result.json>');

  const report = JSON.parse(await readFile(path, 'utf8'));
  const result = validateTrivyResult(report);
  console.log(`Validated bounded Trivy exceptions: ${result.accepted.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
