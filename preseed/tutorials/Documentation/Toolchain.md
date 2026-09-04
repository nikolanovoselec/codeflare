# Toolchain: GitHub to Cloudflare Workers

Build a GitHub Actions pipeline for your own Cloudflare Worker. Ask the agent to do the work or follow the shell path yourself. Both should produce the same result: a tested commit deployed by an auditable workflow. Deployment should be boring. Surprise belongs in the product, not the release log.

---

## Overview

```
Codeflare terminal
  |
  git push
  |
GitHub repository
  |
GitHub Actions (on push to main)
  |
wrangler deploy
  |
Cloudflare Workers (live)
```

---

## Step 1: Create a Cloudflare API Token

> **In Enterprise deployments with Push & Deploy configured**, `wrangler` authenticates through the Worker boundary without exposing a reusable Cloudflare token in the terminal. You'll still need to add deployment credentials to GitHub for CI/CD (Step 3).

You need a token that lets GitHub Actions deploy Workers on your behalf.

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click **Create Token**
3. Use the **Edit Cloudflare Workers** template (this grants the right permissions)
4. Under **Account Resources**, select the account you want to deploy to
5. Under **Zone Resources**, select **All zones** (or a specific zone if you prefer)
6. Click **Continue to summary**, then **Create Token**
7. **Copy the token.** Cloudflare will not show it again.

You also need your **Account ID**:
1. Go to any zone in the Cloudflare dashboard
2. On the right sidebar, find **Account ID**
3. Copy it

---

## Step 2: Set Up a GitHub Repository

> **If you've configured Push & Deploy in Settings**, GitHub authentication is automatic. `git push`, `gh repo create`, and the `gh` CLI all work out of the box without manual login.

### Ask your agent:

```
Create a new GitHub repo called "my-project", clone it into ~/workspace, and set it up with a .gitignore for Node.js
```

### Or do it yourself:

**Option A: Create the repository on GitHub first.**

1. Go to https://github.com/new
2. Name your repository, choose public or private, click **Create repository**
3. From a Codeflare terminal (any terminal tab, Tab 2-6):

```bash
cd ~/workspace
git clone https://github.com/your-username/your-project.git
cd your-project
```

**Option B: Create it from the terminal when the code already exists.**

```bash
cd ~/workspace/your-project
git init
git add .
git commit -m "Initial commit"
gh repo create your-project --public --source=. --remote=origin --push
```

The `gh` CLI is pre-installed in every Codeflare session.

---

## Step 3: Add Secrets to GitHub

Never commit the API token or paste it into an agent conversation. Add it through GitHub’s secret form so it never enters terminal history or agent context.

**Use the GitHub UI:**

1. Go to your repo on GitHub
2. Settings > Secrets and variables > Actions
3. Click **New repository secret**
4. Add `CLOUDFLARE_API_TOKEN` with your token value
5. Add `CLOUDFLARE_ACCOUNT_ID` with your account ID

---

## Step 4: Create the GitHub Actions Workflow

### Ask your agent:

```
Create a GitHub Actions workflow that deploys this project to Cloudflare Workers on every push to main. It should install dependencies, run tests, and deploy using the wrangler-action. Use CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets.
```

### Or do it yourself:

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

This workflow triggers on every push to `main`, installs dependencies, runs your test suite, and deploys using the official Wrangler action.

---

## Step 5: Commit and Push

### Ask your agent:

```
Commit all changes and push to main
```

### Or do it yourself:

```bash
git add .
git commit -m "Add deploy workflow"
git push
```

Go to your repo on GitHub and click the **Actions** tab. You should see the workflow running. When it completes, your Worker is live at:

`https://your-project.your-subdomain.workers.dev`

---

## Step 6: Deploy Updates

After setup, deployment becomes what it should have been all along: a push.

### Ask your agent:

```
Commit my changes and push to deploy
```

### Or do it yourself:

```bash
git add .
git commit -m "Describe your changes"
git push
```

GitHub Actions picks up the push, runs tests, and deploys automatically.

---

## Quick Deploy (No Pipeline)

For quick iterations in an Enterprise deployment with Push & Deploy configured, deploy directly without printing or exporting a reusable credential:

```bash
npx wrangler deploy
```

For repeatable delivery, use the GitHub Actions pipeline above. It keeps deployment credentials in GitHub secrets and records each deployment against its commit and workflow run.

---

## Project Structure Checklist

Before deploying, check that your project has these files:

- `wrangler.toml`: Worker name, compatibility date, and bindings
- `package.json`: Dependencies and scripts
- `src/index.ts`: Worker entry point
- `tsconfig.json`: TypeScript configuration
- `.github/workflows/deploy.yml`: CI/CD pipeline
- `.gitignore`: Exclusions for dependencies, local state, and development secrets

A minimal `.gitignore` for Workers projects:

```
node_modules/
dist/
.wrangler/
.dev.vars
```

---

## Working with KV, R2, and Durable Objects

If your project uses Cloudflare bindings, you need to create them before deploying.

### Ask your agent:

```
Create a KV namespace called MY_KV and an R2 bucket called my-bucket, then add the bindings to wrangler.toml
```

### Or do it yourself:

**KV Namespace:**

```bash
npx wrangler kv namespace create MY_KV
```

Copy the output ID into your `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "MY_KV"
id = "the-id-from-above"
```

**R2 Bucket:**

```bash
npx wrangler r2 bucket create my-bucket
```

```toml
[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "my-bucket"
```

**Durable Objects** are declared in `wrangler.toml` and created automatically on deploy:

```toml
[[durable_objects.bindings]]
name = "MY_DO"
class_name = "MyDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["MyDurableObject"]
```

**Worker secrets** hold API keys and tokens that must not enter source control. Let Wrangler prompt for the value instead of placing it in shell history:

```bash
npx wrangler secret put SECRET_NAME
```

Your Worker receives the secret as `env.SECRET_NAME`.

---

## Environment Variables vs Secrets

- **`[vars]` in `wrangler.toml`:** Committed configuration for non-sensitive values such as feature flags and URLs.
- **`wrangler secret put`:** Encrypted Cloudflare storage for API keys, tokens, and credentials.
- **`.dev.vars`:** Gitignored values used only during local development.

Example `wrangler.toml` vars:

```toml
[vars]
ENVIRONMENT = "production"
API_VERSION = "v2"
```

---

## Tips

**Test locally before deploying.** Use `npx wrangler dev` to run your Worker locally. It simulates the Cloudflare runtime, including KV and R2 bindings. Or ask your agent: "Run this project locally with wrangler dev".

**Use branches for experiments.** You can add preview deploys on pull requests by extending the workflow to trigger on `pull_request` events.

**Check deployment logs.** If a deploy fails, check the GitHub Actions log. Common issues:
- Missing API token secret
- Wrong account ID
- Missing KV namespace or R2 bucket (create them first)
- TypeScript errors (run `npm run build` locally to catch these)

**Keep the token scoped.** The Edit Cloudflare Workers template grants the intended deployment permissions. Do not use a Global API Key. Giving a CI workflow full account access because it was convenient at 4 PM will not become less embarrassing during an incident at 4 AM.

---

## Pro-Mode Shortcuts (Claude Code, advanced session)

Claude Code exposes slash-command shortcuts for the same delivery work. Pi, the primary Enterprise agent, uses its full native tool and skill scope instead.

- **`/sdd init`:** I use it to bootstrap a `sdd/` folder with REQ-tracked requirements before writing code, then work against the specification instead of vibes.
- **`/deploy`:** I use it to drive the GitHub Actions deployment workflow and watch CI until green, without making you ask "is it deployed yet" five times.
- **`/review`:** I use it for applicable security, architecture, code, refactoring, TDD, and documentation perspectives with cross-reference, ADR filtering, and interactive triage. I use `--diff` while iterating, `--all` for a whole-codebase pass, `--deep` for behavioral SDD verification, and `--verify-high` to send surviving HIGH or CRITICAL findings to configured external models for cross-checks and fix proposals. This on-demand workflow is distinct from automatic PR-boundary review and intentionally heavier.
- **`/debug`:** I use it for systematic root-cause analysis when CI fails or the deployed Worker misbehaves.

These shortcuts use the same underlying delivery path. The manual commands remain useful when you need to see exactly what happens.
