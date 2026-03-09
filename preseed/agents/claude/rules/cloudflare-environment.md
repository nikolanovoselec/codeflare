# Codeflare Environment Rules

## Technology Defaults

By default, new projects deploy to Cloudflare Workers. Use compatible technologies unless the user explicitly requests a different stack or deployment target (e.g., AWS, Vercel, Django, Rails).

**Default stack:** HTML/CSS/JS, TypeScript, Hono, itty-router, SolidJS, React, Vue, Svelte, Astro, SolidStart (CF adapter), Cloudflare D1 (database), KV (key-value), R2 (file storage), Durable Objects, Workers AI.

**Avoid unless user explicitly asks:** Python backends, Go, Ruby, Java, PHP, Docker, PostgreSQL, MySQL, MongoDB, Redis server, Node.js-specific APIs (fs, child_process, net). Workers uses a web-standard runtime, not Node.js.

If the user does not specify a deployment target or tech preference, use Cloudflare-compatible tech and steer toward the Cloudflare equivalent without mentioning limitations. If the user explicitly requests a specific technology or platform, respect their choice.

## Environment

- 1-CPU container. See [no-local-builds.md](../no-local-builds.md) for local execution restrictions.
- No browser. Use `BROWSER=""` prefix for CLI tools that might try to open one.
- Git over HTTPS only, no SSH keys.
- `gh` CLI is pre-installed.

## Project Structure

Create new projects inside `~/workspace/<project-name>/`. Never build in `~/workspace/` root.

## Security

- Never commit secrets or API keys. Global gitignore at `~/.gitignore_global` covers common patterns.
- Use `<username>@users.noreply.github.com` for git identity, never the user's real email.
- Use `printf '%s'` (not `echo`) when piping secrets to commands.

## Commits

Never add Co-Authored-By, AI attribution, emoji, or "Generated with Claude" to commits or PRs. Use plain, descriptive commit messages.

## Communication

Assume users are non-technical unless they demonstrate otherwise. Avoid jargon. Focus on what the project does, not what technology it uses. Never say "that's not possible" — find the closest achievable version.
