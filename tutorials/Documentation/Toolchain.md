# Toolchain: GitHub to Cloudflare Workers

How to set up a deployment pipeline for your Cloudflare Workers projects. Every step shows two paths: ask your AI coding agent in Tab 1, or do it manually from a terminal tab.

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

You need a token that lets GitHub Actions deploy Workers on your behalf.

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click **Create Token**
3. Use the **Edit Cloudflare Workers** template (this grants the right permissions)
4. Under **Account Resources**, select the account you want to deploy to
5. Under **Zone Resources**, select **All zones** (or a specific zone if you prefer)
6. Click **Continue to summary**, then **Create Token**
7. **Copy the token** - you will not see it again

You also need your **Account ID**:
1. Go to any zone in the Cloudflare dashboard
2. On the right sidebar, find **Account ID**
3. Copy it

---

## Step 2: Set Up a GitHub Repository

### Ask your agent:

```
Create a new GitHub repo called "my-project", clone it into ~/workspace, and set it up with a .gitignore for Node.js
```

### Or do it yourself:

**Option A - Create on GitHub first (easiest for beginners):**

1. Go to https://github.com/new
2. Name your repository, choose public or private, click **Create repository**
3. From a Codeflare terminal (Tab 4, 5, or 6):

```bash
cd ~/workspace
git clone https://github.com/your-username/your-project.git
cd your-project
```

**Option B - Create from the terminal (if you already have code):**

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

Your API token must never be committed to code or pasted into an AI agent. The safest method is to add secrets directly in the GitHub UI - the token never touches your terminal or any agent context.

**From the GitHub UI (recommended):**

1. Go to your repo on GitHub
2. Settings > Secrets and variables > Actions
3. Click **New repository secret**
4. Add `CLOUDFLARE_API_TOKEN` with your token value
5. Add `CLOUDFLARE_ACCOUNT_ID` with your account ID

**From the terminal (alternative):**

```bash
gh secret set CLOUDFLARE_API_TOKEN --body "your-token-here"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "your-account-id-here"
```

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

After the initial setup, deploying changes is just a push:

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

For quick iterations you can deploy directly from a terminal, but the GitHub Actions pipeline above is the recommended approach since your API token stays safely in GitHub secrets and never enters your terminal session.

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
npx wrangler deploy
```

---

## Project Structure Checklist

Before deploying, make sure your project has these files:

- `wrangler.toml` - Wrangler configuration (name, compatibility date, bindings)
- `package.json` - Dependencies and scripts (npm test, npm run build)
- `src/index.ts` - Worker entry point
- `tsconfig.json` - TypeScript configuration
- `.github/workflows/deploy.yml` - CI/CD pipeline
- `.gitignore` - Exclude node_modules/, .wrangler/, .dev.vars

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

**Worker Secrets** (API keys, tokens that should not be in code):

```bash
echo "secret-value" | npx wrangler secret put SECRET_NAME
```

Secrets are available in your Worker as `env.SECRET_NAME`.

---

## Environment Variables vs Secrets

- **[vars] in wrangler.toml** - stored in config file (committed), visible in code. Use for non-sensitive config like feature flags and URLs.
- **wrangler secret put** - stored in Cloudflare (encrypted), not visible in code. Use for API keys, tokens, and credentials.
- **.dev.vars** - local file (gitignored), only available during local development. Use for development secrets.

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

**Keep your token scoped.** The "Edit Cloudflare Workers" template grants only what is needed. Do not use a Global API Key - it has full account access.
