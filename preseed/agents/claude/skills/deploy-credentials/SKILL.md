---
name: deploy-credentials
description: GitHub and Cloudflare credential reference. Use when gh/wrangler access, managed credentials or Browser Run versus selected OAuth account context is unclear. Covers environment hints, account discovery, operation checks and secret handling.
version: 1.0.0
---

# Deploy Credentials

GitHub and Cloudflare access is **optional** and may use a configured managed connection rather than a raw token. Non-Enterprise deployments also support direct credentials in Settings > Push & Deploy; Enterprise uses its managed connection flows, not manual credential substitution. Check the supported operation before requesting authentication.

## Environment Variables

Availability depends on the deployment and current session. Never print credential values.

| Variable | Purpose |
|---|---|
| `GH_TOKEN` | GitHub credential or managed placeholder consumed by `gh` and the git credential helper. |
| `CLOUDFLARE_API_TOKEN` | Existing Cloudflare credential/managed placeholder; routing chooses the real credential. Do not replace it to select an account. |
| `CLOUDFLARE_ACCOUNT_ID` | Existing account semantics; in Enterprise this is the administrator's Browser Run account. Leave browser consumers unchanged. |
| `CLOUDFLARE_OAUTH_ACCOUNT_ID` | Non-secret selected account from the owner's stored OAuth connection, when available. A startup hint, not a current authorization check or the full account list. |

## Cloudflare account purpose

For management without an explicit user target, prefer the selected OAuth hint when present. For Wrangler, override the account **for that command only**, never globally or in Browser Run configuration:

```bash
# Only when the hint is present and the user has not selected another target:
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_OAUTH_ACCOUNT_ID" npx --yes wrangler deployments list
```

If the hint is absent or access is uncertain, use the supported managed credential path to read `/client/v4/accounts`; do not silently choose among multiple accounts or replace an explicit target. Use the configured credential/client, not an invented bearer literal. A missing raw token does not prove managed OAuth is unavailable. Test the required operation rather than token-verification endpoints.

Connect, disconnect and account selection take effect in shell metadata after session restart. Existing shells can be stale; live discovery may be needed. Keep Browser Run's account and credential routing independent.

## What you can do with GH_TOKEN

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

## What you can do with CLOUDFLARE_API_TOKEN

Use the configured credential and the appropriate account purpose above for authorized Wrangler operations. Variable presence is not proof of permission; provider/account restrictions still apply:

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

## Check-then-fallback

These tokens are optional. When you need GitHub or Cloudflare access:

**Step 1:** check if env vars are set
```bash
echo "${GH_TOKEN:+set}"                # prints "set" if available
echo "${CLOUDFLARE_API_TOKEN:+set}"    # prints "set" if available
```

**Step 2a:** if set, use them directly. Do not ask the user to authenticate again.

**Step 2b:** if NOT set, first check whether the configured managed connection/tool already supports the operation. Missing raw credentials do not authorize bypassing Enterprise provider or identity restrictions. If access is genuinely unavailable, offer only supported options:
1. **Settings (persistent):** use the deployment's GitHub/Cloudflare connection controls, then restart the session for fresh metadata. Direct Push & Deploy credentials are non-Enterprise only.
2. **CLI auth (this session only, where permitted):** For GitHub: `BROWSER="" gh auth login --hostname github.com --git-protocol https --web`. Do not request tokens in chat.
3. **Export in a separate terminal (non-Enterprise, where permitted):** the user can set credentials manually without exposing them to the conversation:
   ```bash
   export GH_TOKEN="github_pat_..."
   export CLOUDFLARE_API_TOKEN="..."
   export CLOUDFLARE_ACCOUNT_ID="..."
   ```

Never assume tokens are present. Always check first.

## Security

- Safest way to handle secrets is for the user to run commands manually in a separate terminal tab. Keeps secrets out of the AI conversation history. When a command involves a secret value, give the user the exact command to paste in a terminal tab rather than running it yourself in the chat.
- Always use `printf '%s'` (not `echo`) when piping secrets to commands.
- Never log or redisplay token values after receiving them.

## Important notes

- Always use `BROWSER=""` prefix when running `gh auth login` or any CLI that might try to open a browser.
- When creating Cloudflare resources, capture the output IDs and update `wrangler.toml` with real values.
- Durable Objects do not need pre-provisioning; wrangler handles them automatically during deploy.
- Tokens configured in Settings take effect on next session start, not immediately.
- When storing secrets as GitHub Actions secrets, use file redirect instead of pipe:
  ```bash
  # WRONG - can store empty values in some environments:
  printf '%s' "$SECRET" | gh secret set SECRET_NAME
  # CORRECT - reliable across all environments:
  TMP=$(mktemp) && echo -n "$SECRET" > "$TMP" && gh secret set SECRET_NAME < "$TMP" && rm "$TMP"
  ```
- When running wrangler in CI, use `npx --yes wrangler deploy` (not `cloudflare/wrangler-action`) to always get the latest version and avoid interactive prompts.
