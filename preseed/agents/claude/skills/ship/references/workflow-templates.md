# GitHub Actions Workflow Templates

## Node.js CI (with tests)

Use when `package.json` exists and has a real `test` script. A "real" test script is one that does NOT contain "no test specified" or just "exit 1" (the default npm init placeholder). Check the actual value of `scripts.test` in package.json before choosing this template.

```yaml
name: CI

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: 'lts/*'

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          else
            npm install
          fi

      - name: Run tests
        run: npm test
```

## Node.js CI (no tests)

Use when `package.json` exists but has no real test script (missing, empty, or the default "no test specified" placeholder).

```yaml
name: CI

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: 'lts/*'

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          else
            npm install
          fi
```

## Minimal CI (static sites)

Use for simple HTML/CSS/JS projects with no `package.json`.

```yaml
name: CI

on:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
```

## CI & Deploy (Cloudflare Workers)

Combined CI and deploy workflow. Installs dependencies and deploys to Cloudflare Workers. Uses a scoped API token from the "Edit Cloudflare Workers" template. Does not include a test step by default — add one before the deploy step only if the project has real tests.

```yaml
name: CI & Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: 'lts/*'

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          elif [ -f package.json ]; then
            npm install
          fi

      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

## Adding Deploy Step to Existing CI Workflow

When the `/ship` skill needs to add deployment to an existing `ci.yml`, append this step after the last existing step and rename the workflow from "CI" to "CI & Deploy":

```yaml
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

## Common .gitignore Templates

### Node.js
```
node_modules/
dist/
.wrangler/
.dev.vars
.env
```

### Generic
```
.env
.DS_Store
```

Note: A global gitignore at `~/.gitignore_global` already excludes dangerous files (secrets, keys, `.env`, `.wrangler/`, `node_modules/`, etc.) so project-level gitignores are supplementary.
