# Cloudflare environment

For a preference-free new project, default to Cloudflare unless the user selects another stack. Load `cloudflare-stack` before choosing architecture.

## Session constraints

- Follow `no-local-builds.md`.
- Do not let CLIs launch a local GUI browser; use configured Browser Run only when authorized.
- Use Git over HTTPS, not SSH keys.
- Use `<username>@users.noreply.github.com` for Git identity, never the user's private email.
- Use `printf '%s'`, not `echo`, when piping secrets.
- Never commit secrets or API keys.

Report hard boundaries honestly and offer the closest safe alternative.
