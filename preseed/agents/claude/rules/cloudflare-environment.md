# Cloudflare-Environment Defaults

This session runs inside codeflare (Cloudflare Workers container). New projects default to deploying on Cloudflare unless the user explicitly chooses another stack.

**Trigger:** any new project, "build me X", "create a website / app", or any tech-stack decision in a fresh project.

**Route:** invoke the `cloudflare-stack` skill for the full default stack, web-standard API mappings, and tech-to-avoid list.

## Hard constraints (never violate)

- Resource-constrained container — see [no-local-builds.md](./no-local-builds.md).
- No browser — use `BROWSER=""` prefix for CLI tools that try to open one.
- Git over HTTPS only, no SSH keys.
- Use `<username>@users.noreply.github.com` for git identity, never the user's real email.
- Use `printf '%s'` (not `echo`) when piping secrets to commands.
- Never commit secrets or API keys. Global gitignore at `~/.gitignore_global` covers common patterns.

## Communication

Assume users are non-technical unless they demonstrate otherwise. Avoid jargon. Focus on what the project does, not what technology it uses. Never say "that's not possible" — find the closest achievable version.
