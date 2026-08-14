# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| latest | :white_check_mark: |

## Reporting a Vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/nikolanovoselec/codeflare/security/advisories/new). **Do not open a public issue.**

### What to include

Provide the affected version or commit, deployment mode where relevant, reproducible steps, observed and expected behavior, impact, and any safe supporting evidence. Describe whether the issue crosses an identity, session, container, storage, credential, network, or release boundary.

### Sensitive information

Do not include real credentials, private deployment values, customer data, exploit payloads against a live third-party target, or private operations procedures in a public issue, pull request, or repository file. Use the private advisory thread for sensitive evidence.

### Response and disclosure

You can expect an initial response within 72 hours. We will work with you to validate scope, coordinate remediation, and agree on disclosure timing before publication. GitHub documents the reporting process in its [private vulnerability reporting guide](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

## Scope

Codeflare gives trusted engineering agents broad capability inside isolated session containers. Reports are in scope when they affect Codeflare-owned identity, authorization, tenancy, routing, credential placement, persistence, egress, browser proxying, supply chain, or delivery controls. Vulnerabilities in an upstream provider or user project should be reported to that owner unless Codeflare's integration creates or widens the issue.

The supported release is the latest published Codeflare version. Historical releases, user-modified images, and unsupported deployment combinations may be investigated for impact but are not maintained as separate supported branches.

## Security Architecture

<a id="authentication"></a>
<a id="security-headers"></a>
<a id="rate-limiting"></a>
<a id="input-validation"></a>
<a id="csrf-protection"></a>
<a id="container-isolation"></a>
<a id="storage-isolation"></a>
<a id="email-system-resend"></a>
<a id="usage-tracking-timekeeper-do"></a>
<a id="supply-chain-security"></a>
<a id="github-security-features"></a>
<a id="cors-policy"></a>
<a id="websocket-security"></a>
<a id="push--deploy-credentials"></a>
<a id="automated-penetration-testing"></a>

This policy owns supported versions and vulnerability reporting. The canonical technical [threat model, controls, failure posture, exceptions, and residual risks](documentation/lanes/security.md) live in the Security lane. Identity flow belongs to [Authentication](documentation/lanes/authentication.md), exact routes to the [API Reference](documentation/lanes/api-reference.md), persistence boundaries to [Storage & Sync](documentation/lanes/storage-and-sync.md), runtime isolation to [Architecture](documentation/lanes/architecture.md), and delivery gates to [CI/CD](documentation/lanes/ci-cd.md).

Codeflare's controls constrain powerful agents; they do not make arbitrary commands harmless, undo external side effects, or certify customer deployments. Current scheduled probe contracts and dated observations are separated in [Penetration Testing](documentation/lanes/pentest.md).

## Related Documentation

- [Security Reference](documentation/lanes/security.md) — technical controls and accepted risks
- [Authentication](documentation/lanes/authentication.md) — identity, sessions, and authorization
- [Architecture](documentation/lanes/architecture.md) — component and trust boundaries
- [API Reference](documentation/lanes/api-reference.md) — public and private route contracts
- [CI/CD](documentation/lanes/ci-cd.md) — source-owned verification and release gates
- [Architecture Decisions](documentation/decisions/README.md) — preserved rationale and trade-offs
- [Contributing](CONTRIBUTING.md) — development and disclosure expectations
