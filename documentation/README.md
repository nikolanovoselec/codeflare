# Codeflare Documentation

Operator and developer reference for Codeflare - an ephemeral cloud IDE that runs AI coding agents in isolated containers on Cloudflare's edge.

This documentation is organized into **lanes** - each file targets a specific audience (operator, developer, or security) and covers one operational slice of the system. Facts live in one place and are cross-referenced elsewhere. When documentation implements a specification requirement, the file links back to the relevant REQ in `sdd/` via anchor references.

The specification (`sdd/`) defines what the system should do. This documentation describes how it works in production - configuration, troubleshooting, architecture, and operational procedures. Together they form a closed loop: requirements drive implementation, implementation is documented, and documentation links back to requirements.

## Documentation Principles

1. **Operator-focused lanes** - Each document targets a specific audience and covers one concern. An operator looking for sync troubleshooting finds it in Storage & Sync, not scattered across Architecture and Deployment.

2. **Spec-backed** - Documentation implements specification requirements. REQ backlinks at the bottom of each file connect operational docs to their acceptance criteria in `sdd/`.

3. **Single source of truth** - Each fact lives in exactly one file. Other files cross-reference via markdown links rather than duplicating content. When a detail changes, it changes in one place.

4. **Decisions recorded** - Architecture decisions are captured as numbered ADRs in `decisions/README.md` with context, rationale, and trade-offs. Code comments and documentation reference ADR numbers rather than re-explaining the reasoning.

## Audience Guide

| Audience | Start here |
|----------|------------|
| Operator | [Configuration](lanes/configuration.md), [Container](lanes/container.md), [Storage & Sync](lanes/storage-and-sync.md), [Troubleshooting](lanes/troubleshooting.md) |
| Developer | [Architecture](lanes/architecture.md), [API Reference](lanes/api-reference.md), [CI/CD](lanes/ci-cd.md), [Preseed System](lanes/preseed.md) |
| Security | [Security](lanes/security.md), [Penetration Testing](lanes/pentest.md), [Authentication](lanes/authentication.md) |

## Lane Index

| Document | Description | Audience |
|----------|-------------|----------|
| [Architecture](lanes/architecture.md) | System overview, components, data flow, design rationale | Developers |
| [Architecture Internals](lanes/architecture-internals.md) | Backend library reference, code structure, CF-NNN index | Developers |
| [API Reference](lanes/api-reference.md) | All API endpoints, request/response formats | Developers |
| [Authentication & Billing](lanes/authentication.md) | Dual auth (CF Access + OIDC), SaaS mode, three-tier middleware | Operators, Developers, Security |
| [Billing & Subscription](lanes/billing.md) | Stripe integration, subscription tiers, Timekeeper, paygate | Operators, Developers |
| [User Provisioning](lanes/user-provisioning.md) | JIT provisioning, subscribe page, session mode authorization | Operators, Developers |
| [Security](lanes/security.md) | Security model, encryption, rate limiting, hardening | Operators, Security |
| [Configuration](lanes/configuration.md) | Environment variables, secrets, CORS, API token permissions | Operators |
| [Container](lanes/container.md) | Container image, startup, AI tools, auto-sleep, Push & Deploy | Operators, Developers |
| [Storage & Sync](lanes/storage-and-sync.md) | R2 storage, rclone bisync, sync modes, quotas | Operators |
| [CI/CD & Testing](lanes/ci-cd.md) | GitHub Actions workflows, test suites, E2E setup | Developers |
| [Development & Deployment](lanes/deployment.md) | Dev setup, file structure, cost analysis | Developers |
| [Troubleshooting](lanes/troubleshooting.md) | Diagnostic commands, common failures, resolutions | Operators |
| [Mobile Terminal](lanes/mobile.md) | Keyboard handling, scroll stability, touch input | Developers |
| [Vault](lanes/vault.md) | Persistent user note vault, cross-session memory capture, unified graphify graph, SilverBullet editor | Developers |
| [Preseed System](lanes/preseed.md) | Session modes, manifest pipeline, multi-agent adaptation, hooks, troubleshooting | Developers |
| [Architecture Decisions](decisions/README.md) | 59 ADRs (44 active) with rationale and trade-offs | Developers |
| [Penetration Testing](lanes/pentest.md) | Security scan results | Security |
| [Stress Testing](lanes/stress-test.md) | Load testing guide, latest benchmark results | Operators |

## Architecture Decisions

All significant design choices are recorded as Architecture Decision Records (ADRs) with context, alternatives considered, and rationale. See [decisions/README.md](decisions/README.md) for the full ledger.

## Other Documentation

| Document | Location | Description |
|----------|----------|-------------|
| [README](../README.md) | Repo root | Product overview and setup |
| [Contributing](../CONTRIBUTING.md) | Repo root | Development workflow and guidelines |
| [Security Policy](../SECURITY.md) | Repo root | Vulnerability reporting |
| [License](../LICENSE) | Repo root | PolyForm Noncommercial 1.0.0 |
