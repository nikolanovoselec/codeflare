# Codeflare Documentation

Technical reference documentation for Codeflare.

---

| Document | Description | Audience |
|----------|-------------|----------|
| [Architecture](lanes/architecture.md) | System overview, components, data flow, design rationale | Developers |
| [Architecture Internals](lanes/architecture-internals.md) | Backend library reference, code structure, CF-NNN index | Developers |
| [API Reference](lanes/api-reference.md) | All API endpoints, request/response formats | Developers |
| [Authentication & Billing](lanes/authentication.md) | Dual auth (CF Access + OIDC), SaaS mode, three-tier middleware | Operators, Developers |
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
| [Memory](lanes/memory.md) | Vault-based cross-session memory, automatic capture to Raw/Sessions/, hook mechanics | Developers |
| [Vault](lanes/vault.md) | Persistent user note vault, unified graphify graph, SilverBullet editor | Developers |
| [Preseed System](lanes/preseed.md) | Session modes, manifest pipeline, multi-agent adaptation, hooks | Developers |
| [Preseed Troubleshooting](lanes/preseed-troubleshooting.md) | Hook debugging, attribution blocking, checkpoint reset | Developers |
| [Token Scopes](lanes/token-scopes.md) | GitHub PAT and Cloudflare API token scope guidance | Operators |
| [Architecture Decisions](decisions/README.md) | 59 ADRs (44 active) with rationale and trade-offs | Developers |
| [Penetration Testing](lanes/PENTEST.md) | Security scan results | Security |
| [Stress Testing](lanes/STRESS_TEST.md) | Load testing guide | Operators |
| [Stress Testing Results](lanes/STRESS_TEST-results.md) | Latest benchmark results, file index, Timekeeper load | Operators |

## Other Documentation

| Document | Location | Description |
|----------|----------|-------------|
| [README](../README.md) | Repo root | Product overview and setup |
| [Contributing](../CONTRIBUTING.md) | Repo root | Development workflow and guidelines |
| [Security Policy](../SECURITY.md) | Repo root | Vulnerability reporting |
| [License](../LICENSE) | Repo root | PolyForm Noncommercial 1.0.0 |
