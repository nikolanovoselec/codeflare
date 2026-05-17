# Codeflare Documentation

Technical reference documentation for Codeflare.

---

| Document | Description | Audience |
|----------|-------------|----------|
| [Architecture](architecture.md) | System overview, components, data flow, design rationale | Developers |
| [Architecture Internals](architecture-internals.md) | Backend library reference, code structure, CF-NNN index | Developers |
| [API Reference](api-reference.md) | All API endpoints, request/response formats | Developers |
| [Authentication & Billing](authentication.md) | Dual auth (CF Access + OIDC), SaaS mode, three-tier middleware | Operators, Developers |
| [Billing & Subscription](billing.md) | Stripe integration, subscription tiers, Timekeeper, paygate | Operators, Developers |
| [User Provisioning](user-provisioning.md) | JIT provisioning, subscribe page, session mode authorization | Operators, Developers |
| [Security](security.md) | Security model, encryption, rate limiting, hardening | Operators, Security |
| [Configuration](configuration.md) | Environment variables, secrets, CORS, API token permissions | Operators |
| [Container](container.md) | Container image, startup, AI tools, auto-sleep, Push & Deploy | Operators, Developers |
| [Storage & Sync](storage-and-sync.md) | R2 storage, rclone bisync, sync modes, quotas | Operators |
| [CI/CD & Testing](ci-cd.md) | GitHub Actions workflows, test suites, E2E setup | Developers |
| [Development & Deployment](deployment.md) | Dev setup, file structure, cost analysis | Developers |
| [Troubleshooting](troubleshooting.md) | Diagnostic commands, common failures, resolutions | Operators |
| [Mobile Terminal](mobile.md) | Keyboard handling, scroll stability, touch input | Developers |
| [Memory](memory.md) | Vault-based cross-session memory, automatic capture to Raw/Sessions/, hook mechanics | Developers |
| [Vault](vault.md) | Persistent user note vault, unified graphify graph, SilverBullet editor | Developers |
| [Preseed System](preseed.md) | Session modes, manifest pipeline, multi-agent adaptation, hooks | Developers |
| [Preseed Troubleshooting](preseed-troubleshooting.md) | Hook debugging, attribution blocking, checkpoint reset | Developers |
| [Token Scopes](token-scopes.md) | GitHub PAT and Cloudflare API token scope guidance | Operators |
| [Architecture Decisions](decisions/README.md) | 52 ADRs (38 active) with rationale and trade-offs | Developers |
| [Penetration Testing](PENTEST.md) | Security scan results | Security |
| [Stress Testing](STRESS_TEST.md) | Load testing guide | Operators |
| [Stress Testing Results](STRESS_TEST-results.md) | Latest benchmark results, file index, Timekeeper load | Operators |

## Other Documentation

| Document | Location | Description |
|----------|----------|-------------|
| [README](../README.md) | Repo root | Product overview and setup |
| [Contributing](../CONTRIBUTING.md) | Repo root | Development workflow and guidelines |
| [Security Policy](../SECURITY.md) | Repo root | Vulnerability reporting |
| [License](../LICENSE) | Repo root | PolyForm Noncommercial 1.0.0 |
