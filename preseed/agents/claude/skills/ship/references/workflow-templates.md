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

Use this deployment template only when the user requests GitHub Actions deployment setup and has a suitable scoped Cloudflare API token for the repository's Actions secrets. Otherwise recommend direct deployment through their Cloudflare connection. Keep required checks, including any real test suite, ahead of deployment.

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
        run: npx --yes wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

## Adding Deploy Step to Existing CI Workflow

Only for a requested Actions deployment, add the deploy step after required checks in the appropriate job or gate a separate deploy job on them. Preserve the repository's intended triggers and environment:

```yaml
      - name: Deploy to Cloudflare Workers
        run: npx --yes wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
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
