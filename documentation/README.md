# Codeflare Documentation

Technical reference documentation for Codeflare.

---

| Document | Description | Audience |
|----------|-------------|----------|
| [Architecture](architecture.md) | System overview, components, data flow, design rationale | Developers |
| [API Reference](api-reference.md) | All API endpoints, request/response formats | Developers |
| [Authentication & Billing](authentication.md) | Dual auth (CF Access + OIDC), SaaS mode, subscriptions, Stripe | Operators, Developers |
| [Security](security.md) | Security model, encryption, rate limiting, hardening | Operators, Security |
| [Configuration](configuration.md) | Environment variables, secrets, CORS, API token permissions | Operators |
| [Container](container.md) | Container image, startup, AI tools, auto-sleep, Push & Deploy | Operators, Developers |
| [Storage & Sync](storage-and-sync.md) | R2 storage, rclone bisync, sync modes, quotas | Operators |
| [CI/CD & Testing](ci-cd.md) | GitHub Actions workflows, test suites, E2E setup | Developers |
| [Development & Deployment](deployment.md) | Dev setup, file structure, cost analysis | Developers |
| [Troubleshooting](troubleshooting.md) | Diagnostic commands, common failures, resolutions | Operators |
| [Mobile Terminal](mobile.md) | Keyboard handling, scroll stability, touch input | Developers |
| [Memory](memory.md) | MCP memory server, automatic capture, two-phase compaction | Developers |
| [Preseed System](preseed.md) | Session modes, manifest pipeline, multi-agent adaptation, hooks | Developers |
| [Token Scopes](token-scopes.md) | GitHub PAT and Cloudflare API token scope guidance | Operators |
| [Architecture Decisions](decisions/README.md) | 44 ADRs with rationale and trade-offs | Developers |
| [Penetration Testing](PENTEST.md) | Security scan results | Security |
| [Stress Testing](STRESS_TEST.md) | Load testing guide | Operators |

## Other Documentation

| Document | Location | Description |
|----------|----------|-------------|
| [README](../README.md) | Repo root | Product overview and setup |
| [Contributing](../CONTRIBUTING.md) | Repo root | Development workflow and guidelines |
| [Security Policy](../SECURITY.md) | Repo root | Vulnerability reporting |
| [License](../LICENSE) | Repo root | PolyForm Noncommercial 1.0.0 |
