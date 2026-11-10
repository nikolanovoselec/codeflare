# Codeflare Documentation

Operator and developer reference for Codeflare - an agentic engineering engine that runs governed engineering agents in isolated containers on Cloudflare's edge.

This documentation is organized into **lanes** - each file targets a specific audience (operator, developer, or security) and covers one operational slice of the system. Facts live in one place and are cross-referenced elsewhere. When documentation implements a specification requirement, the file links back to the relevant REQ in `sdd/` via anchor references.

The specification (`sdd/`) defines required system behavior. This documentation describes public implementation behavior and default-mode operation. Together they form a closed loop: requirements drive implementation, implementation is documented, and documentation links back to requirements.

The [Model Context Protocol specification](../sdd/spec/mcp.md) owns portal and client requirements. [Model Context Protocol](lanes/mcp.md) owns connection, authorization, discovery, execution and recovery guidance; Configuration, API Reference and Agent Environment retain their adjacent responsibilities. Browser automation remains separate under [Browser Run](../sdd/spec/browser-run.md).

## Documentation Principles

1. **Operator-focused lanes** - Each document targets a specific audience and covers one concern. An operator looking for sync troubleshooting finds it in Storage & Sync, not scattered across Architecture and Deployment.

2. **Spec-backed** - Documentation implements specification requirements. REQ backlinks at the bottom of each file connect operational docs to their acceptance criteria in `sdd/`.

3. **Single source of truth** - Each lane states its ownership and exclusions; other files cross-reference it. Dependency versions and integrity values belong in manifests, locks, image pins and provenance—not a second documentation inventory.

4. **Decisions recorded** - Architecture decisions are captured as numbered ADRs in `decisions/README.md` with context, rationale, and trade-offs. Code comments and documentation reference ADR numbers rather than re-explaining the reasoning.

5. **Durable ownership** - The lanes in the Lane Index are the canonical owners. Extend the existing owner before proposing another lane.

6. **Reference, not campaign history** - Lanes describe current behavior and qualified limitations. Exact CI receipts, deployment observations and dated measurements remain in existing Git, PR and CI records; architecture rationale belongs in the ADR ledger. Do not create execution-report lanes.

A model release, implementation mechanism, repair, transport adapter, or delivery campaign is a section or reference, not a new domain. Preserve referenced assets, requirement IDs and fragment aliases when consolidating content.

## Public/private documentation boundary

Public documentation owns default-mode setup, product behavior, architecture, and REQ/ADR backlinks. Exact non-default deployment secrets, variables, operator token-permission matrices, GitHub Environments, and operator runbooks live in the [private operator library](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/README.md) (access required).

When public workflows or consumers change, update the owning document in the [private operator library](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/README.md) in the same work. Public docs link there rather than duplicate operational matrices or runbooks.

**Private operations:** a task that reads or changes a non-default deployment secret, variable, operator token-permission matrix, GitHub Environment, customer-account prerequisite, provider registration, promotion check, migration procedure, or rollback runbook also owns an update in `codeflare-private`. If it is not already available, clone it with `gh repo clone nikolanovoselec/codeflare-private`. Read its [documentation contract](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/governance/documentation-contract.md), update the owning private document, and deliver that repository through its own review history. Never copy real credentials or customer identifiers into either repository. Never duplicate private operational values in public `code`, `sdd/`, or `documentation/`; keep public behavior and REQ/ADR backlinks here and link to the private owner.

**Managed curation:** [codeflare-curation](https://github.com/nikolanovoselec/codeflare-curation) is the runtime master for Managed Environment content; Codeflare's `preseed/` is the independent image-baked fallback. Shared skills, rules, agents, hooks, prompts and Pi extensions require aligned changes in both sources, with affected manifests, modes and generated output checked, as directed by [AGENTS.md](../AGENTS.md) and [Contributing](../CONTRIBUTING.md). Public contributors identify affected copies for maintainer coordination; private repository access is not a contribution prerequisite. Editing the baked fallback alone does not update an active managed deployment. Compiler, transform, seed ABI and Pi runtime-lock changes land in Codeflare first, then curation advances its compiler pin. Verify signed managed publication and runtime activation separately from source alignment; none is implied by another. See [Managed curation ownership](lanes/preseed.md#managed-curation-ownership).

## Pending delivery

The non-normative [SDD remediation overview](../SDD-REMEDIATION.md) tracks the approved cleanup scopes and publication milestones. It does not establish runtime acceptance or change the operational owners below.

[Operator verification boundaries](lanes/operators.md#verification-boundaries) distinguish historical delivery receipts from current runtime qualification and hosted acceptance. The [Operator requirements](../sdd/spec/operators.md#req-operator-048-dispatcher-execution) own the trusted normal-host contract; no separate pending-work document is maintained.

## Audience Guide

| Audience | Start here |
|----------|------------|
| Operator | [Architecture](lanes/architecture.md), [Configuration](lanes/configuration.md), [Container](lanes/container.md), [Storage & Sync](lanes/storage-and-sync.md), [Troubleshooting](lanes/troubleshooting.md); use the [private operator library](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/README.md) for non-default deployment |
| Developer | [Architecture](lanes/architecture.md), [API Reference](lanes/api-reference.md), [CI/CD](lanes/ci-cd.md), [Preseed System](lanes/preseed.md) |
| Security | [Security](lanes/security.md), [CI & Testing](lanes/ci-cd.md), [Identity & Access](lanes/authentication.md) |

## Lane Index

| Document | Owns | Audience |
|----------|------|----------|
| [Agent Environment](lanes/preseed.md) | Manifests, modes, compiler projection, baked fallback, managed curation and agent adaptation | Developers |
| [API Reference](lanes/api-reference.md) | Endpoint authorization, request/response/error contracts and limits | Developers |
| [Architecture](lanes/architecture.md) | System topology, state authority, cross-component flows and failure boundaries | Operators, Developers |
| [Billing & Usage](lanes/billing.md) | Entitlement, subscriptions, live quota accounting, historical usage, reports and retention | Operators, Developers |
| [CI & Testing](lanes/ci-cd.md) | Verification routing, pipeline gates, security-probe methodology and safe load testing | Developers, Operators, Security |
| [Configuration & Administration](lanes/configuration.md) | Settings, defaults, precedence, redaction and administrative editing workflows | Operators, Developers |
| [Deployment](lanes/deployment.md) | Default promotion, acceptance, rollback and public target boundaries | Operators, Developers |
| [Identity & Access](lanes/authentication.md) | Verified identity, authentication, authorization, account admission, provisioning and offboarding | Operators, Developers, Security |
| [Model Context Protocol](lanes/mcp.md) | Portal connection, owner authorization, discovery, execution and recovery | Users, Administrators, Developers |
| [Models & Routing](lanes/models-and-routing.md) | Target identity, routing, discovery, evidence, reasoning, replay, caching and runtime publication | Operators, Developers |
| [Operators](lanes/operators.md) | Packages, installations, grants, admission, activities, parent capabilities and publication fencing | Operators, Developers, Security |
| [Security](lanes/security.md) | Threats, trust boundaries, controls, exceptions and residual risks | Operators, Developers, Security |
| [Sessions & Runtime](lanes/container.md) | Image and process orchestration, D1 session authority, startup, recovery, idle policy and teardown | Operators, Developers |
| [Storage & Sync](lanes/storage-and-sync.md) | R2/local authority, reconciliation, conflicts, persistence and encryption-regime integration | Operators, Developers |
| [Terminal & IDE](lanes/terminal-and-ide.md) | Workspace interactions, terminal/editor connectivity and mobile compatibility | Operators, Developers |
| [Troubleshooting](lanes/troubleshooting.md) | Symptom-led diagnosis, corrective action, verification and escalation | Operators |
| [Vault & Memory](lanes/vault.md) | Notes, editor behavior, capture, recall, extraction and knowledge-graph publication | Operators, Developers |

## Specification coverage

Each specification domain has an explicit documentation owner. Shared lanes cover related operational concerns; package references retain package-local guidance. These links identify ownership, not completed acceptance.

| Specification domain | Documentation owner(s) |
|---|---|
| [Agents](../sdd/spec/agents.md) | [Agent Environment](lanes/preseed.md) |
| [Authentication](../sdd/spec/authentication.md) | [Identity & Access](lanes/authentication.md), [Security](lanes/security.md) |
| [Browser IDE](../sdd/spec/browser-ide.md) | [Terminal & IDE](lanes/terminal-and-ide.md), [Browser IDE agents](../openvscode/README.md) |
| [Browser Run](../sdd/spec/browser-run.md) | [API Reference](lanes/api-reference.md), [Agent Environment](lanes/preseed.md), [Configuration](lanes/configuration.md) |
| [GitHub](../sdd/spec/github.md) | [Identity & Access](lanes/authentication.md), [API Reference](lanes/api-reference.md) |
| [Landing](../sdd/spec/landing.md) | [Landing package](../landing/README.md), [Architecture](lanes/architecture.md) |
| [Memory](../sdd/spec/memory.md) | [Vault & Memory](lanes/vault.md) |
| [Model Context Protocol](../sdd/spec/mcp.md) | [Model Context Protocol](lanes/mcp.md) |
| [Models & Routing](../sdd/spec/models-and-routing.md) | [Models & Routing](lanes/models-and-routing.md) |
| [Operations](../sdd/spec/operations.md) | [CI & Testing](lanes/ci-cd.md), [Deployment](lanes/deployment.md) |
| [Operators](../sdd/spec/operators.md) | [Operators](lanes/operators.md) |
| [Security](../sdd/spec/security.md) | [Security](lanes/security.md) |
| [Session Lifecycle](../sdd/spec/session-lifecycle.md) | [Sessions & Runtime](lanes/container.md), [Terminal & IDE](lanes/terminal-and-ide.md) |
| [Setup & Administration](../sdd/spec/setup.md) | [Configuration & Administration](lanes/configuration.md), [Deployment](lanes/deployment.md) |
| [Storage](../sdd/spec/storage.md) | [Storage & Sync](lanes/storage-and-sync.md) |
| [Subscription](../sdd/spec/subscription.md) | [Billing & Usage](lanes/billing.md) |
| [Terminal](../sdd/spec/terminal.md) | [Terminal & IDE](lanes/terminal-and-ide.md) |
| [Vault](../sdd/spec/vault.md) | [Vault & Memory](lanes/vault.md) |

## Package Reference Index

| Package reference | Owns | System contracts remain in |
|---|---|---|
| [Browser IDE agents](../openvscode/README.md) | Extension inventories, package composition, local verification | [Sessions & Runtime](lanes/container.md), [Terminal & IDE](lanes/terminal-and-ide.md), [Security](lanes/security.md) |
| [Claude IDE configuration](../openvscode/claude/README.md) | Claude projection files and managed settings | [Browser IDE agents](../openvscode/README.md) and [Container](lanes/container.md) |
| [Landing](../landing/README.md) | Landing source map, browser behavior, build order, package verification | [Architecture](lanes/architecture.md), [API Reference](lanes/api-reference.md), [Security](lanes/security.md) |
| [Pi packages](references/pi-packages.md) | Locked package inventory, entrypoints, compatibility transforms and prewarm gates | [Agent Environment](lanes/preseed.md), [Sessions & Runtime](lanes/container.md) |

## Change Routing

| Change type | Canonical owner | Secondary updates when affected |
|---|---|---|
| Public or private route contract | [API Reference](lanes/api-reference.md) | Security, specialist runtime lane, owning SDD requirement |
| Public configuration, default, or mode overlay | [Configuration](lanes/configuration.md) | Deployment, Security, owning SDD requirement |
| Operator deployment, verification, or rollback | [Development & Deployment](lanes/deployment.md) | CI/CD when workflow topology changes |
| Workflow trigger, permission, gate, or artifact | [CI/CD & Testing](lanes/ci-cd.md) | Deployment or package reference for consumer changes |
| Runtime image, process, lifecycle, or recovery | [Sessions & Runtime](lanes/container.md) | Terminal & IDE for client behavior; Architecture only when component ownership changes |
| Identity, entitlement, provisioning, or security control | Identity & Access, Billing & Usage, or Security | API and Configuration only for their owned surfaces |
| Model/protocol, routing, discovery, reasoning, replay or cache policy | [Models & Routing](lanes/models-and-routing.md) | Configuration for setting/editing contracts; Security for shared trust controls |
| Operator package, installation, activity or parent capability | [Operators](lanes/operators.md) | API for wire contracts; package repository for business policy |
| Package-only source composition or build | Owning package reference above | Canonical system lane only when the public contract changes |
| Vulnerability reporting policy | [Security Policy](../SECURITY.md) | Technical controls remain in [Security](lanes/security.md) |
| Required behavior or evidence | Owning file in [`sdd/spec/`](../sdd/README.md) | Canonical lane and changelog |
| Non-default deployment value, provider registration, or operator runbook | [Private operator library](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/README.md) | Public behavior owner and REQ/ADR backlinks remain here |

## Architecture Decisions

All significant design choices are recorded as Architecture Decision Records (ADRs) with context, alternatives considered, and rationale. See [decisions/README.md](decisions/README.md) for the full ledger.

## Other Documentation

| Document | Location | Description |
|----------|----------|-------------|
| [README](../README.md) | Repo root | Product overview and default-mode setup |
| [Private operator library](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/README.md) | Private repository | Non-default deployment, integration, migration, verification, and rollback runbooks |
| [Curated content](https://github.com/nikolanovoselec/codeflare-curation) | Private repository | Runtime master for Managed Environment content and company extension requirements |
| [Contributing](../CONTRIBUTING.md) | Repo root | Development workflow and guidelines |
| [Security Policy](../SECURITY.md) | Repo root | Vulnerability reporting |
| [License](../LICENSE) | Repo root | PolyForm Noncommercial 1.0.0 |
