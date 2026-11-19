# Cloudflare environment

For a preference-free new project, default to Cloudflare unless the user selects another stack. Load `cloudflare-stack` before choosing architecture.

## Session constraints

- Follow `no-local-builds.md`.
- Do not let CLIs launch a local GUI browser; use configured Browser Run only when authorized.
- Use Git over HTTPS, not SSH keys.
- Use `<username>@users.noreply.github.com` for Git identity, never the user's private email.
- Use `printf '%s'`, not `echo`, when piping secrets.
- Never commit secrets or API keys.

## Cloudflare account context

`CLOUDFLARE_ACCOUNT_ID` keeps its existing role; in Enterprise it targets administrator Browser Run. `CLOUDFLARE_OAUTH_ACCOUNT_ID`, when present, is the owner's selected OAuth management account hint, not authorization. Preserve explicit user targets; otherwise prefer that hint for management, overriding Wrangler's account variable for the command only. Never globally replace Browser Run's account or credential. If selection/access is unclear, use managed `/client/v4/accounts` discovery without auto-selecting among accounts or requesting secrets. Metadata can be stale until session restart. Load `deploy-credentials` for the complete routing workflow.

Report hard boundaries honestly and offer the closest safe alternative.
