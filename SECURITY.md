# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| latest | :white_check_mark: |

## Reporting a Vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/nikolanovoselec/codeflare/security/advisories/new). **Do not open a public issue.**

You can expect an initial response within 72 hours. We will work with you to understand the issue and coordinate a fix before public disclosure. GitHub documents the reporting process in its [private vulnerability reporting guide](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

Do not include real credentials, private deployment values, customer data, or private operations procedures in a public report or repository change.

## Security Architecture

This file owns supported-version and vulnerability-reporting policy. The canonical technical threat model, controls, failure posture, and residual risks live in [Security](documentation/lanes/security.md); identity flow lives in [Authentication](documentation/lanes/authentication.md), exact routes in the [API Reference](documentation/lanes/api-reference.md), and persistence boundaries in [Storage & Sync](documentation/lanes/storage-and-sync.md).

Codeflare gives trusted engineering agents broad capability inside isolated session containers. Its controls constrain identity, tenancy, routing, credential placement, persistence, egress, and delivery; they do not make arbitrary agent commands harmless or undo external side effects.

### Authentication

Deployments use the configured Cloudflare Access or Worker-managed session identity path. Service automation is a separate explicit path. Credential precedence, verified-email requirements, cookies, middleware tiers, session limits, Enterprise elevation, and accepted-but-unimplemented service-auth restrictions are documented in [Authentication](documentation/lanes/authentication.md#authentication-modes) and [Security](documentation/lanes/security.md#authentication-gate).

### Security Headers

The Worker applies route-appropriate security headers and a stricter policy to API responses. Current values and their source anchors are maintained in [Security — Security Headers](documentation/lanes/security.md#security-headers); do not copy them into deployment-specific runbooks.

### Rate Limiting

HTTP and WebSocket limits are enforced at authenticated boundaries, with explicit endpoint contracts in the [API Reference](documentation/lanes/api-reference.md). Concurrent-session admission is best effort rather than an atomic reservation, and deployment capacity remains a separate hard ceiling. Stress-test bypass behavior and its integration-only safety boundary are documented in [Stress Testing](documentation/lanes/stress-test.md).

### Input Validation

External request bodies, identifiers, origins, paths, and provider responses are validated at their owning boundary. Body and route limits belong to [Security](documentation/lanes/security.md#body-limit) and the [API Reference](documentation/lanes/api-reference.md); implementation details are not policy promises in this file.

### CSRF Protection

State-changing browser requests use the authentication mode's CSRF controls, including the required request marker where applicable. The exact enforcement boundary and Vault bootstrap exception are documented in [Security](documentation/lanes/security.md).

### Container Isolation

Each session receives a distinct Cloudflare Container, lifecycle coordinator, authenticated route, agent process tree, and ephemeral local filesystem. Agents, terminals, and trusted IDE extensions retain broad filesystem and command access inside that boundary. See [Architecture](documentation/lanes/architecture.md#container-runtime-trust-boundary) and [Container](documentation/lanes/container.md).

### Storage Isolation

Durable storage authority is derived from verified user identity rather than a caller-supplied bucket selector. Workspace sync is periodic and conflict-aware, not transactional; governed encryption and mixed-regime recovery have explicit operator consequences. See [Storage & Sync](documentation/lanes/storage-and-sync.md) and [Vault](documentation/lanes/vault.md).

### Email System (Resend)

Outbound mail is best effort, escapes user-controlled HTML content, uses bounded provider calls, and does not make the calling user flow depend on delivery. Message ownership, ordering, and idempotency vary by flow; [Architecture](documentation/lanes/architecture.md#onboarding-access-request-flow-req-auth-021), [Billing](documentation/lanes/billing.md), and [User Provisioning](documentation/lanes/user-provisioning.md) own those contracts.

### Usage Tracking (Timekeeper DO)

Timekeeper isolates accounting by user, persists its accumulator state, binds identity, and clamps deltas. It is a usage and quota signal, not an atomic session-admission lock. Current ordering and enforcement behavior are documented in [Billing](documentation/lanes/billing.md#usage-tracking-timekeeper-do).

### Supply Chain Security

Reviewed exact-head checks, dependency review, static analysis, image scanning, provenance, SBOMs, and keyless release signing form the maintained release gate. Accepted scanner exceptions remain explicit and bounded. Workflow names, triggers, permissions, and artifact contracts belong to [CI/CD](documentation/lanes/ci-cd.md).

### GitHub Security Features

Repository security settings such as private vulnerability reporting, secret scanning, push protection, branch protection, and Dependabot controls are verified out of band because source cannot prove their live state. Source-owned workflow gates are documented separately in [CI/CD](documentation/lanes/ci-cd.md#branch-protection).

### CORS Policy

Configured exact origins and bounded suffix patterns control cross-origin access; origin matching is not an authentication substitute. Setup-time and deployment-mode behavior belongs to [Configuration](documentation/lanes/configuration.md#cors-configuration), with rationale preserved in the architecture decisions.

### WebSocket Security

Terminal, Browser IDE, and other upgraded routes authenticate before forwarding, validate route and session ownership, and use a lifecycle-scoped container credential on the private hop. Payload, connection, and recovery limits belong to the [API Reference](documentation/lanes/api-reference.md), [Container](documentation/lanes/container.md), and [Architecture](documentation/lanes/architecture.md).

### Push & Deploy Credentials

The Worker deployment credential never enters a session container. User/provider credential handling depends on mode: supported credentials are encrypted at rest, scoped where possible, and in Enterprise or OAuth interception paths may be withheld from the container and injected only at a validated egress boundary. See [Security — API Token Containment](documentation/lanes/security.md#api-token-containment) for the current boundary. Never commit real credentials or private non-default values.

### Automated Penetration Testing

The scheduled workflow runs bounded external probes against a validated production origin. The current probe contract and its limitations are documented separately from the dated black-box snapshot in [Penetration Testing](documentation/lanes/pentest.md). A passing probe is evidence for that target and time, not a universal certification.

## Related Documentation

- [Security Reference](documentation/lanes/security.md) — threat model, controls, residual risks, and source anchors
- [Authentication](documentation/lanes/authentication.md) — identity, sessions, and authorization
- [Architecture](documentation/lanes/architecture.md) — trust and component boundaries
- [CI/CD](documentation/lanes/ci-cd.md) — source-owned delivery gates
- [Architecture Decisions](documentation/decisions/README.md) — preserved rationale and trade-offs
- [Contributing](CONTRIBUTING.md) — development and disclosure expectations
