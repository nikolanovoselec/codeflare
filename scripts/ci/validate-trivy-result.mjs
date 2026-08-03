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
    // Deployment 30849615814 at head a2fc364 and image
    // sha256:432f2c4c53a38efd78ce7304147512feb0d45c0063dd94c6fbe26c99f46e55b2
    // exposed this second exact tuple after the 5.0.5 tuple was accepted.
    // Remove when the image no longer contains brace-expansion 5.0.7.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69152',
    packageName: 'brace-expansion',
    installedVersion: '5.0.7',
    fixedVersion: '1.1.18, 2.1.4, 3.0.6, 5.0.9',
    severity: 'HIGH',
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

  const expected = new Map(REVIEWED_FINDINGS.map((finding) => [findingKey(finding), finding]));
  const seen = new Set();
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
      if (!expected.has(key) || seen.has(key)) {
        findings.push(
          `unexpected HIGH/CRITICAL finding: ${finding.vulnerabilityId} ${finding.packageName} `
          + `${finding.installedVersion} -> ${finding.fixedVersion} at ${finding.target}`,
        );
      } else {
        seen.add(key);
      }
    }
  }

  for (const [key, finding] of expected) {
    if (!seen.has(key)) {
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
