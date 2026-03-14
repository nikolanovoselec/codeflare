# Deploy Credentials

GitHub and Cloudflare credentials are **optional**. They may be pre-configured via Settings > Push & Deploy, but many users will not have them set.

## Environment Variables

These variables are only present if the user configured them in Settings. Always check before assuming they exist.

| Variable | What it enables |
|---|---|
| `GH_TOKEN` | GitHub fine-grained PAT. Auto-detected by `gh` CLI and git credential helper. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token. Auto-detected by `wrangler` CLI. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID. Auto-detected by `wrangler` CLI. |

## What You Can Do with GH_TOKEN

When `GH_TOKEN` is set, all of the following work without any manual auth:

**Git operations:**
- `git push`, `git pull`, `git clone` (HTTPS remotes, auto-authenticated via credential helper)
- `git push -u origin HEAD` (set upstream and push)

**Repository management:**
- `gh repo create <name> --public --source=. --remote=origin --push`
- `gh repo clone <owner>/<repo>`
- `gh repo delete <owner>/<repo> --yes`
- `gh repo list` (find user's repositories)

**Pull requests:**
- `gh pr create --title "..." --body "..."`
- `gh pr list`, `gh pr view`, `gh pr merge`

**CI / GitHub Actions:**
- `gh run list`, `gh run view <id>`, `gh run view <id> --log-failed`
- `gh run cancel <id>` (cancel stale CI runs)
- `gh secret set <name>` (set repository secrets for CI workflows)
- `gh secret list` (verify secrets are stored)

**User identity:**
- `gh api user --jq '.login'` (get GitHub username)
- `gh api user --jq '.name'` (get display name)
- `gh auth status` (verify token is active)

## What You Can Do with CLOUDFLARE_API_TOKEN

When both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set, all wrangler commands work without manual auth:

**Deploy:**
- `npx -y wrangler deploy` (deploy Worker to Cloudflare)
- `npx -y wrangler pages deploy <dir>` (deploy Pages project)

**D1 databases:**
- `npx -y wrangler d1 create <name>` (create database, returns database_id for wrangler.toml)
- `npx -y wrangler d1 execute <name> --remote --file=schema.sql` (apply schema)
- `npx -y wrangler d1 execute <name> --remote --command="SELECT * FROM ..."` (run queries)

**R2 storage:**
- `npx -y wrangler r2 bucket create <name>` (create bucket)
- `npx -y wrangler r2 bucket list` (list existing buckets)

**KV namespaces:**
- `npx -y wrangler kv namespace create <name>` (create namespace, returns id for wrangler.toml)
- `npx -y wrangler kv namespace list` (list existing namespaces)
- `npx -y wrangler kv key put --namespace-id=<id> <key> <value>` (set a key)

**Secrets:**
- `printf '%s' "value" | npx -y wrangler secret put <name>` (set Worker secret)
- `npx -y wrangler secret list` (list secret names)

**Other:**
- `npx -y wrangler tail` (live-tail Worker logs)
- `npx -y wrangler whoami` (verify token and account)

## Behavior — Check, Then Fallback

These tokens are optional. When you need GitHub or Cloudflare access:

**Step 1: Check if env vars are set**
```bash
echo "${GH_TOKEN:+set}"                # prints "set" if available
echo "${CLOUDFLARE_API_TOKEN:+set}"    # prints "set" if available
```

**Step 2a: If set** — use them directly. Do not ask the user to authenticate again.

**Step 2b: If NOT set** — offer the user three options:
1. **Settings (persistent):** "You can connect your GitHub/Cloudflare account in Settings > Push & Deploy. This will apply to all future sessions. You'll need to start a new session for the tokens to take effect."
2. **CLI auth (this session only):** For GitHub: `BROWSER="" gh auth login --hostname github.com --git-protocol https --web`. For Cloudflare: ask the user to paste their token.
3. **Export in terminal (this session only):** The user can set the variables manually:
   ```bash
   export GH_TOKEN="github_pat_..."
   export CLOUDFLARE_API_TOKEN="..."
   export CLOUDFLARE_ACCOUNT_ID="..."
   ```

Never assume tokens are present. Always check first.

## Security

- The safest way to handle secrets is for the user to run commands manually in a separate terminal tab. This keeps secrets out of the AI conversation history. When a command involves a secret value, give the user the exact command to paste in a terminal tab rather than running it yourself in the chat.
- Always use `printf '%s'` (not `echo`) when piping secrets to commands.
- Never log or redisplay token values after receiving them.

## Important Notes

- Always use `BROWSER=""` prefix when running `gh auth login` or any CLI that might try to open a browser.
- When creating Cloudflare resources, capture the output IDs and update `wrangler.toml` with real values.
- Durable Objects do not need pre-provisioning - wrangler handles them automatically during deploy.
- Tokens configured in Settings take effect on next session start, not immediately.
- When storing secrets as GitHub Actions secrets, use file redirect instead of pipe:
  ```bash
  # WRONG — can store empty values in some environments:
  printf '%s' "$SECRET" | gh secret set SECRET_NAME
  # CORRECT — reliable across all environments:
  TMP=$(mktemp) && echo -n "$SECRET" > "$TMP" && gh secret set SECRET_NAME < "$TMP" && rm "$TMP"
  ```
- When running wrangler in CI, use `npx --yes wrangler deploy` (not `cloudflare/wrangler-action`) to always get the latest version and avoid interactive prompts.
