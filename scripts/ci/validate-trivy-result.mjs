#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REVIEWED_FINDINGS = [
  {
    // Reviewed from integration deployment 30847836723 at head a05cf374 and
    // image sha256:324dc992f5d65aa9ab597a382ca6d35bd0629bfd502f809369547760dd767e3f.
    // Trivy reports this package under its generic Node.js target. The DoS
    // remains confined to the authenticated user's single-tenant container.
    // Remove when the image no longer contains brace-expansion 5.0.5.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69152',
    packageName: 'brace-expansion',
    packagePath: 'usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json',
    packagePurl: 'pkg:npm/brace-expansion@5.0.5',
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
    packagePath: 'opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json',
    packagePurl: 'pkg:npm/brace-expansion@5.0.7',
    installedVersion: '5.0.7',
    fixedVersion: '1.1.18, 2.1.4, 3.0.6, 5.0.9',
    severity: 'HIGH',
  },
  {
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69152',
    packageName: 'brace-expansion',
    packagePath: 'opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json',
    packagePurl: 'pkg:npm/brace-expansion@5.0.7',
    installedVersion: '5.0.7',
    fixedVersion: '1.1.18, 2.1.4, 3.0.6, 5.0.9',
    severity: 'HIGH',
  },
  {
    // Integration deployments 30893082736/30893082817 at head 8a745b7 and
    // image IDs sha256:2ee1ac0/sha256:5847655 reported this stale declaration.
    // Every committed runtime lock resolves ip-address to patched 10.4.0.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69192',
    packageName: 'ip-address',
    packagePath: 'usr/local/lib/node_modules/npm/node_modules/ip-address/package.json',
    packagePurl: 'pkg:npm/ip-address@10.1.0',
    installedVersion: '10.1.0',
    fixedVersion: '10.3.1',
    severity: 'HIGH',
  },
  {
    // The same complete scans reported two 10.2.0 declarations. Evidence run
    // 30896944558 bound them to code-server's VS Code and server package trees.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69192',
    packageName: 'ip-address',
    packagePath: 'opt/code-server/lib/vscode/node_modules/ip-address/package.json',
    packagePurl: 'pkg:npm/ip-address@10.2.0',
    installedVersion: '10.2.0',
    fixedVersion: '10.3.1',
    severity: 'HIGH',
  },
  {
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-69192',
    packageName: 'ip-address',
    packagePath: 'opt/code-server/node_modules/ip-address/package.json',
    packagePurl: 'pkg:npm/ip-address@10.2.0',
    installedVersion: '10.2.0',
    fixedVersion: '10.3.1',
    severity: 'HIGH',
  },
  {
    // Node/npm image tooling carries undici 7.28.0. Codeflare does not enable
    // its shared cache interceptor; use remains inside one user's container.
    // Remove when the pinned Node base image carries undici 7.29.0 or later.
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-13697',
    packageName: 'undici',
    packagePath: 'opt/code-server/lib/vscode/node_modules/undici/package.json',
    packagePurl: 'pkg:npm/undici@7.28.0',
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
    packagePath: 'opt/codeflare/npm-tools/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json',
    packagePurl: 'pkg:npm/undici@8.5.0',
    installedVersion: '8.5.0',
    fixedVersion: '7.29.0, 8.9.0',
    severity: 'HIGH',
  },
  {
    target: 'Node.js',
    vulnerabilityId: 'CVE-2026-13697',
    packageName: 'undici',
    packagePath: 'opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/package.json',
    packagePurl: 'pkg:npm/undici@8.5.0',
    installedVersion: '8.5.0',
    fixedVersion: '7.29.0, 8.9.0',
    severity: 'HIGH',
  },
  {
    // Integration runs 31102705391 and 31105573226 reported this exact Debian
    // package pair. The content-addressed image tag changes with build inputs,
    // so bind its target shape plus each package PURL/version and multiplicity.
    // Remove when apt resolves 16.02+really26.02+dfsg-0+deb12u1 or later.
    target: 'codeflare integration image (debian 12.15)',
    targetPattern: '^codeflare-integration-container:in-[a-f0-9]{16} \\(debian 12\\.15\\)$',
    vulnerabilityId: 'CVE-2026-14266',
    packageName: 'p7zip',
    packagePurl: 'pkg:deb/debian/p7zip@16.02%2Breally26.01%2Bdfsg-0%2Bdeb12u1?arch=amd64&distro=debian-12.15',
    installedVersion: '16.02+really26.01+dfsg-0+deb12u1',
    fixedVersion: '16.02+really26.02+dfsg-0+deb12u1',
    severity: 'HIGH',
  },
  {
    target: 'codeflare integration image (debian 12.15)',
    targetPattern: '^codeflare-integration-container:in-[a-f0-9]{16} \\(debian 12\\.15\\)$',
    vulnerabilityId: 'CVE-2026-14266',
    packageName: 'p7zip-full',
    packagePurl: 'pkg:deb/debian/p7zip-full@16.02%2Breally26.01%2Bdfsg-0%2Bdeb12u1?arch=amd64&distro=debian-12.15',
    installedVersion: '16.02+really26.01+dfsg-0+deb12u1',
    fixedVersion: '16.02+really26.02+dfsg-0+deb12u1',
    severity: 'HIGH',
  },
];

function matchesReviewedFinding(reviewed, finding) {
  const targetMatches = reviewed.targetPattern
    ? new RegExp(reviewed.targetPattern).test(finding.target)
    : reviewed.target === finding.target;
  return targetMatches
    && reviewed.vulnerabilityId === finding.vulnerabilityId
    && reviewed.packageName === finding.packageName
    && reviewed.packagePath === finding.packagePath
    && reviewed.packagePurl === finding.packagePurl
    && reviewed.installedVersion === finding.installedVersion
    && reviewed.fixedVersion === finding.fixedVersion
    && reviewed.severity === finding.severity;
}

export function validateTrivyResult(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.Results)) {
    throw new Error('Trivy report must contain a Results array');
  }

  const seen = REVIEWED_FINDINGS.map(() => 0);
  const findings = [];
  const evidence = [];

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
        packagePath: typeof vulnerability.PkgPath === 'string' && vulnerability.PkgPath.length > 0
          ? vulnerability.PkgPath
          : undefined,
        packagePurl: typeof vulnerability.PkgIdentifier?.PURL === 'string' && vulnerability.PkgIdentifier.PURL.length > 0
          ? vulnerability.PkgIdentifier.PURL
          : undefined,
        installedVersion: vulnerability.InstalledVersion,
        fixedVersion: vulnerability.FixedVersion,
        severity: vulnerability.Severity,
      };
      const reviewedIndex = REVIEWED_FINDINGS.findIndex((reviewed, index) =>
        seen[index] < (reviewed.occurrences ?? 1) && matchesReviewedFinding(reviewed, finding));
      if (reviewedIndex === -1) {
        findings.push(
          `unexpected HIGH/CRITICAL finding: ${finding.vulnerabilityId} ${finding.packageName} `
          + `${finding.installedVersion} -> ${finding.fixedVersion} at ${finding.target} `
          + `[path=${finding.packagePath ?? '<unavailable>'}; purl=${finding.packagePurl ?? '<unavailable>'}]`,
        );
      } else {
        seen[reviewedIndex] += 1;
        evidence.push(
          `${finding.vulnerabilityId} ${finding.packageName} ${finding.installedVersion} at ${finding.target} `
          + `[path=${finding.packagePath ?? '<unavailable>'}; purl=${finding.packagePurl ?? '<unavailable>'}]`,
        );
      }
    }
  }

  for (const [index, finding] of REVIEWED_FINDINGS.entries()) {
    const occurrences = finding.occurrences ?? 1;
    if (seen[index] < occurrences) {
      findings.push(
        `missing reviewed finding: ${finding.vulnerabilityId} ${finding.packageName} `
        + `${finding.installedVersion} at ${finding.target} `
        + `[path=${finding.packagePath ?? '<unavailable>'}; purl=${finding.packagePurl ?? '<unavailable>'}]; `
        + 'remove or re-review the exception',
      );
    }
  }

  if (findings.length > 0) throw new Error(findings.join('\n'));

  return {
    accepted: [...new Set(REVIEWED_FINDINGS.map((finding) => `${finding.target}@${finding.installedVersion}`))],
    evidence,
  };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: validate-trivy-result.mjs <trivy-result.json>');

  const report = JSON.parse(await readFile(path, 'utf8'));
  const result = validateTrivyResult(report);
  console.log(`Validated bounded Trivy exceptions: ${result.accepted.join(', ')}`);
  for (const identity of result.evidence) console.log(`Observed reviewed Trivy identity: ${identity}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
