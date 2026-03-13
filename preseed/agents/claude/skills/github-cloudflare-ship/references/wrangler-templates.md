# Wrangler Configuration & Worker Templates

Always replace `my-project` with the actual project name (lowercase, hyphenated — use the repo name or directory name). Replace `YYYY-MM-01` with the first of the current month (e.g., `2026-04-01` if it is April 2026).

## Workers with TypeScript

```toml
name = "my-project"
main = "src/index.ts"
compatibility_date = "YYYY-MM-01"
```

## Workers with JavaScript

```toml
name = "my-project"
main = "src/index.js"
compatibility_date = "YYYY-MM-01"
```

## Static Site (Workers Assets)

For static HTML/CSS/JS projects. Always use a dedicated directory like `./public` — never use `./` as it would expose `wrangler.toml`, `package.json`, and other config files as public assets.

```toml
name = "my-project"
compatibility_date = "YYYY-MM-01"

[assets]
directory = "./public"
```

If HTML files are in the project root, move them to a `public/` directory before deploying.

## Workers with KV Binding

```toml
name = "my-project"
main = "src/index.ts"
compatibility_date = "YYYY-MM-01"

[[kv_namespaces]]
binding = "MY_KV"
id = "create-via-wrangler-kv-namespace-create"
```

Create the namespace first — the agent should run this automatically when `$CLOUDFLARE_API_TOKEN` is set:
```bash
npx -y wrangler kv namespace create MY_KV
```
Capture the namespace `id` from the output and replace the placeholder in wrangler.toml.

## Workers with R2 Bucket

```toml
name = "my-project"
main = "src/index.ts"
compatibility_date = "YYYY-MM-01"

[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "my-bucket"
```

Create the bucket first — the agent should run this automatically when `$CLOUDFLARE_API_TOKEN` is set:
```bash
npx -y wrangler r2 bucket create my-bucket
```

## Workers with D1 Database

```toml
name = "my-project"
main = "src/index.ts"
compatibility_date = "YYYY-MM-01"

[[d1_databases]]
binding = "DB"
database_name = "my-database"
database_id = "create-via-wrangler-d1-create"
```

Create the database first — the agent should run this automatically when `$CLOUDFLARE_API_TOKEN` is set:
```bash
npx -y wrangler d1 create my-database
```
Capture the `database_id` from the output and replace the placeholder in wrangler.toml.

## Workers with Durable Objects

```toml
name = "my-project"
main = "src/index.ts"
compatibility_date = "YYYY-MM-01"

[[durable_objects.bindings]]
name = "MY_DO"
class_name = "MyDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["MyDurableObject"]
```

## Minimal Worker Entry Point (TypeScript)

```typescript
interface Env {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("Hello World!");
  },
};
```

## Minimal Worker Entry Point (JavaScript)

```javascript
export default {
  async fetch(request, env, ctx) {
    return new Response("Hello World!");
  },
};
```

## Environment Variables

Non-sensitive config goes in `[vars]`:

```toml
[vars]
ENVIRONMENT = "production"
```

Sensitive values go in GitHub Secrets and are accessed via `wrangler-action`. For Workers-specific secrets, use interactive mode (never echo values):

```bash
npx -y wrangler secret put SECRET_NAME
```
