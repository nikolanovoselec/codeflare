# Codeflare Documentation

Operator and developer reference for Codeflare - an agentic engineering engine that runs governed engineering agents in isolated containers on Cloudflare's edge.

This documentation is organized into **lanes** - each file targets a specific audience (operator, developer, or security) and covers one operational slice of the system. Facts live in one place and are cross-referenced elsewhere. When documentation implements a specification requirement, the file links back to the relevant REQ in `sdd/` via anchor references.

The specification (`sdd/`) defines required system behavior. This documentation describes public implementation behavior and default-mode operation. Together they form a closed loop: requirements drive implementation, implementation is documented, and documentation links back to requirements.

## Documentation Principles

1. **Operator-focused lanes** - Each document targets a specific audience and covers one concern. An operator looking for sync troubleshooting finds it in Storage & Sync, not scattered across Architecture and Deployment.

2. **Spec-backed** - Documentation implements specification requirements. REQ backlinks at the bottom of each file connect operational docs to their acceptance criteria in `sdd/`.

3. **Single source of truth** - Each fact lives in exactly one file. Every lane states what it owns and excludes; other files cross-reference the owner rather than duplicating content. When a detail changes, it changes in one place.

4. **Decisions recorded** - Architecture decisions are captured as numbered ADRs in `decisions/README.md` with context, rationale, and trade-offs. Code comments and documentation reference ADR numbers rather than re-explaining the reasoning.

5. **Structure preserved** - The specialized files in the Lane Index are Codeflare's canonical documentation structure. Clean content in place; do not fold these files into generic mega-lanes or delete their referenced assets.

## Public/private documentation boundary

Public documentation owns default-mode setup, product behavior, architecture, and REQ/ADR backlinks. Exact non-default deployment secrets, variables, token scopes, GitHub Environments, and operator runbooks live in [private operations](https://github.com/nikolanovoselec/codeflare-private) (access required).

When their public workflows or consumers change, update the private README in the same work. Public docs link there rather than duplicate the operational matrix.

**Agents:** to read or modify a non-default deployment secret, variable, or token scope, do it in [codeflare-private](https://github.com/nikolanovoselec/codeflare-private) — those values are not stored in this repository. Never write a real secret, a non-default deployment variable, or a token-scope value into this public repo (code, `sdd/`, or `documentation/`); reference the private repo instead.

**Agents:** to add or change a deployment-managed skill, rule, hook, agent, script, plugin, or company extension requirement, clone [codeflare-curation](https://github.com/nikolanovoselec/codeflare-curation) and push the change there. That private repository is the runtime master for Managed Environment content; `preseed/agents/**` in this repository is only the image-baked fallback baseline, and editing it does not change what deployments receive. Edit the fallback here only when the task is explicitly about it. Compiler, transform, seed ABI, and Pi runtime-lock changes are the exception: they land in this repository first, and only then does the curation repo advance its compiler pin. See [Managed curation ownership](lanes/preseed.md#managed-curation-ownership).

## Audience Guide

| Audience | Start here |
|----------|------------|
| Operator | [Architecture](lanes/architecture.md), [Configuration](lanes/configuration.md), [Container](lanes/container.md), [Storage & Sync](lanes/storage-and-sync.md), [Troubleshooting](lanes/troubleshooting.md); use [private operations](https://github.com/nikolanovoselec/codeflare-private) for non-default deployment |
| Developer | [Architecture](lanes/architecture.md), [API Reference](lanes/api-reference.md), [CI/CD](lanes/ci-cd.md), [Preseed System](lanes/preseed.md) |
| Security | [Security](lanes/security.md), [Penetration Testing](lanes/pentest.md), [Authentication](lanes/authentication.md) |

## Lane Index

| Document | Description | Audience |
|----------|-------------|----------|
| [Architecture](lanes/architecture.md) | System map, component and state ownership, cross-component flows, failure boundaries | Operators, Developers |
| [Architecture Internals](lanes/architecture-internals.md) | Source composition, runtime/client internals, caches, backend libraries, CF-NNN index | Developers |
| [API Reference](lanes/api-reference.md) | All API endpoints, request/response formats | Developers |
| [Authentication](lanes/authentication.md) | Identity resolution, CF Access and OIDC sessions, authorization middleware | Operators, Developers, Security |
| [Billing & Subscription](lanes/billing.md) | Stripe integration, subscription tiers, Timekeeper, paygate | Operators, Developers |
| [User Provisioning](lanes/user-provisioning.md) | JIT provisioning, subscribe page, session mode authorization | Operators, Developers |
| [Security](lanes/security.md) | Security model, encryption, rate limiting, hardening | Operators, Security |
| [Configuration](lanes/configuration.md) | Default-mode configuration and public runtime behavior | Operators |
| [Container](lanes/container.md) | Container image, startup, AI tools, auto-sleep, Push & Deploy | Operators, Developers |
| [Storage & Sync](lanes/storage-and-sync.md) | R2 storage, rclone bisync, sync modes, quotas | Operators |
| [CI/CD & Testing](lanes/ci-cd.md) | Public workflow behavior and test-suite structure | Developers |
| [Development & Deployment](lanes/deployment.md) | Deployment execution, verification, rollback, development references, dated cost evidence | Developers, Operators |
| [Troubleshooting](lanes/troubleshooting.md) | Diagnostic commands, common failures, resolutions | Operators |
| [Mobile Terminal](lanes/mobile.md) | Keyboard handling, scroll stability, touch input | Developers |
| [Vault](lanes/vault.md) | Persistent user note vault, cross-session memory capture, unified graphify graph, SilverBullet editor | Developers |
| [Preseed System](lanes/preseed.md) | Session modes, manifest pipeline, multi-agent adaptation, hooks, troubleshooting | Developers |
| [Architecture Decisions](decisions/README.md) | Architecture Decision Records with rationale and trade-offs | Developers |
| [Penetration Testing](lanes/pentest.md) | Current scheduled probe contract and dated black-box evidence | Security |
| [Stress Testing](lanes/stress-test.md) | Load-suite safety, execution, thresholds, and dated results | Operators |

## Package Reference Index

| Package reference | Owns | System contracts remain in |
|---|---|---|
| [Landing](../landing/README.md) | Landing source map, browser behavior, build order, package verification | [Architecture Internals](lanes/architecture-internals.md), [API Reference](lanes/api-reference.md), [Security](lanes/security.md) |
| [Browser IDE agents](../openvscode/README.md) | Extension inventories, package composition, local verification | [Container](lanes/container.md), [Architecture Internals](lanes/architecture-internals.md), [Security](lanes/security.md) |
| [Claude IDE configuration](../openvscode/claude/README.md) | Claude projection files and managed settings | [Browser IDE agents](../openvscode/README.md) and [Container](lanes/container.md) |

## Change Routing

| Change type | Canonical owner | Secondary updates when affected |
|---|---|---|
| Public or private route contract | [API Reference](lanes/api-reference.md) | Security, specialist runtime lane, owning SDD requirement |
| Public configuration, default, or mode overlay | [Configuration](lanes/configuration.md) | Deployment, Security, owning SDD requirement |
| Operator deployment, verification, or rollback | [Development & Deployment](lanes/deployment.md) | CI/CD when workflow topology changes |
| Workflow trigger, permission, gate, or artifact | [CI/CD & Testing](lanes/ci-cd.md) | Deployment or package reference for consumer changes |
| Runtime image, process, lifecycle, or recovery | [Container](lanes/container.md) or specialist runtime lane | Architecture map only when component ownership changes |
| Identity, entitlement, provisioning, or security control | Authentication, Billing, User Provisioning, or Security lane | API and Configuration only for their owned surfaces |
| Package-only source composition or build | Owning package reference above | Canonical system lane only when the public contract changes |
| Vulnerability reporting policy | [Security Policy](../SECURITY.md) | Technical controls remain in [Security](lanes/security.md) |
| Required behavior or evidence | Owning file in [`sdd/spec/`](../sdd/README.md) | Canonical lane and changelog |

## Architecture Decisions

All significant design choices are recorded as Architecture Decision Records (ADRs) with context, alternatives considered, and rationale. See [decisions/README.md](decisions/README.md) for the full ledger.

## Other Documentation

| Document | Location | Description |
|----------|----------|-------------|
| [README](../README.md) | Repo root | Product overview and default-mode setup |
| [Private operations](https://github.com/nikolanovoselec/codeflare-private) | Private repository | Non-default deployment and operator configuration |
| [Curated content](https://github.com/nikolanovoselec/codeflare-curation) | Private repository | Runtime master for Managed Environment content and company extension requirements |
| [Contributing](../CONTRIBUTING.md) | Repo root | Development workflow and guidelines |
| [Security Policy](../SECURITY.md) | Repo root | Vulnerability reporting |
| [License](../LICENSE) | Repo root | PolyForm Noncommercial 1.0.0 |
