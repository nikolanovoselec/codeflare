# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Codeflare, please report it through
[GitHub Security Advisories](https://github.com/nikolanovoselec/codeflare/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

## Response Timeline

- **Acknowledgment**: within 72 hours of report submission
- **Fix target**: within 30 days of confirmed vulnerability

## Scope

This policy covers the Codeflare application, including:

- Cloudflare Worker backend (`src/`)
- Container runtime (`host/`, `Dockerfile`, `entrypoint.sh`)
- Frontend application (`web-ui/`)
- CI/CD workflows (`.github/workflows/`)
- Configuration and deployment scripts

## Supported Versions

Only the latest release on the `main` branch is supported with security updates.
