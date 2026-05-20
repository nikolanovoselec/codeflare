# Entry-Point Probes (per-language reference)

Used by `sdd-init` Phase 6c (lifecycle synthesis) and Phase 6d (endpoint contract enumeration) to identify entry points in a codebase. Each entry point becomes a Request Lifecycle subsection in `documentation/architecture.md` and (if it's an HTTP / RPC / queue handler) one entry in `documentation/api-reference.md`.

The probes below are deliberately conservative — they catch the canonical shape per stack, not every variant. Phase 6c walks the project's primary source tree and applies the probes matching the project's detected stack (from package manifest + file-extension prevalence).

## Stack detection

| Manifest file | Detected stack |
|---|---|
| `package.json` with `astro` dep | Astro Worker |
| `package.json` with `@cloudflare/workers-types` dep, no astro | Cloudflare Worker (bare) |
| `package.json` with `express` or `fastify` or `hono` | Node HTTP server |
| `package.json` with `next` | Next.js |
| `pubspec.yaml` | Dart / Flutter |
| `Cargo.toml` with `actix-web` / `axum` / `rocket` / `warp` | Rust web |
| `Cargo.toml` without web framework | Rust CLI / library |
| `go.mod` with `gin-gonic` / `chi` / `echo` | Go web |
| `go.mod` without web framework | Go CLI / library |
| `requirements.txt` or `pyproject.toml` with `flask` / `fastapi` / `django` | Python web |
| `requirements.txt` or `pyproject.toml` with `celery` | Python + task queue |
| `Gemfile` with `rails` | Ruby on Rails |
| Android manifest exists (`android/app/src/main/AndroidManifest.xml`) | Android native bridge present (in addition to mobile-framework stack) |
| Xcode project / `*.xcodeproj` | iOS native bridge present |

A project may match multiple stacks (e.g., Dart Flutter + Android native bridge + Cloudflare Worker). Apply all matching probes.

## HTTP / RPC entry-point probes

### Cloudflare Worker

- `export default { fetch(request, env, ctx) }` — primary HTTP entry. The `fetch` handler is the entire HTTP surface.
- `export default { scheduled(controller, env, ctx) }` — cron entry. One entry per `triggers.crons` in `wrangler.toml`.
- `export default { queue(batch, env, ctx) }` — queue consumer. One entry per queue binding in `wrangler.toml`.
- `export default { tail(events, env, ctx) }` — tail-worker entry (logging).

Routing parser: a single `fetch` handler. Routes inside are discovered via `URL` parsing patterns (`url.pathname.startsWith(...)`, `if (url.pathname === ...)`, framework router calls).

### Astro Worker

- `src/pages/**/*.astro` — page route. The file path is the route (`index.astro` → `/`, `digest.astro` → `/digest`, `digest/[id]/[slug].astro` → `/digest/:id/:slug`).
- `src/pages/api/**/*.ts` — JSON API route. Exports named `GET`, `POST`, `PUT`, `DELETE`, `PATCH` (each is one endpoint).
- `src/middleware/index.ts` — middleware chain (every request passes through; not itself an entry, but a cross-cutting concern).

Routing parser: filesystem-driven. No central config to parse.

### Next.js

- `app/**/page.tsx` — page route (App Router).
- `app/**/route.ts` — API route. Exports named `GET`, `POST`, etc.
- `pages/**/*.tsx` — page route (Pages Router, legacy).
- `pages/api/**/*.ts` — API route. Default export handler with `req.method` switch.
- `middleware.ts` — edge middleware.

### Express / Fastify / Hono

- `app.get(path, handler)`, `app.post(...)`, etc. — per-route registration.
- `app.use(path, router)` — sub-router.
- `router.{get|post|put|delete|patch}(...)` — per-route on a router.

Routing parser: build a static-analysis call graph for `app.METHOD` / `router.METHOD` registrations. Each call site = one endpoint.

### Flask

- `@app.route("/path", methods=[...])` — per-route decorator.
- `@blueprint.route(...)` — per-route on a blueprint.

### FastAPI

- `@app.get("/path")`, `@app.post(...)`, etc. — per-route decorator.
- `@router.{get|post|...}(...)` — per-route on a router.

### Django

- `urls.py` `path(...)` and `re_path(...)` entries. View functions / class-based views are the targets.

### Rails

- `config/routes.rb` — `get`, `post`, `resources`, `namespace` entries. Each `resources :foo` expands to 7 endpoints (index, show, new, create, edit, update, destroy).

### Rust web

- `actix-web`: `App::new().route(path, web::get().to(handler))`.
- `axum`: `Router::new().route(path, get(handler))`.
- `rocket`: `#[get("/path")]`, `#[post(...)]` macros.
- `warp`: filter combinators — harder to statically parse; treat as one entry per top-level filter chain.

### Go web

- `gin`: `router.GET("/path", handler)`.
- `chi`: `r.Get("/path", handler)`.
- `echo`: `e.GET("/path", handler)`.
- `net/http`: `http.HandleFunc("/path", handler)` or `mux.Handle(pattern, handler)`.

## Scheduled / cron entry-point probes

| Stack | Pattern |
|---|---|
| Cloudflare Worker | `export default { scheduled }` + `wrangler.toml` `[triggers] crons = [...]` |
| Node (cron lib) | `cron.schedule("...", handler)` or `new CronJob(...)` |
| Astro Worker | Inherits CF Worker pattern |
| Python (Celery beat) | `app.conf.beat_schedule = { ... }` |
| Python (APScheduler) | `scheduler.add_job(handler, "cron", ...)` |
| Rails | `config/schedule.rb` (whenever gem) or `Sidekiq cron` |
| Go | Cron lib `c.AddFunc("...", handler)` |
| Generic | `crontab` file in repo |

## Queue / message-handler probes

| Stack | Pattern |
|---|---|
| Cloudflare Workers Queues | `export default { queue(batch, env) }` + `wrangler.toml` `[queues.consumers]` |
| BullMQ | `new Worker(queueName, async (job) => ...)` |
| Sidekiq (Ruby) | `class FooWorker; include Sidekiq::Worker; def perform(...); end; end` |
| Celery (Python) | `@app.task` decorator |
| SQS consumer (any) | Long-poll loop calling `ReceiveMessage` |
| AWS Lambda | Handler exports per the runtime; SAM/serverless config maps events |

## CLI / process entry-point probes

| Stack | Pattern |
|---|---|
| Node | `package.json` `bin` field; `#!/usr/bin/env node` shebang at top of file |
| Python | `pyproject.toml` `[project.scripts]`; `__main__` blocks |
| Go | `func main()` in `main` package |
| Rust | `[[bin]]` entries in `Cargo.toml`; `fn main()` in `src/main.rs` |
| Dart / Flutter | `void main()` in `lib/main.dart` |

## Mobile / OS-integration entry-point probes

### Android (Kotlin / Java)

- `MainActivity.kt` or any `Activity` subclass with an `<intent-filter>` declaration in `AndroidManifest.xml`. Each intent filter is a potential entry point (`ACTION_VIEW`, `ACTION_SEND`, `ACTION_SEND_MULTIPLE`, deep-link scheme matchers).
- `onCreate(savedInstanceState)` — cold-start entry.
- `onNewIntent(intent)` — warm-start entry for `launchMode=singleTop`.
- BroadcastReceiver classes — system event handlers.
- Foreground / background Service classes.
- WorkManager `Worker` subclasses.

### iOS (Swift)

- `@main` struct conforming to `App` protocol — SwiftUI entry.
- `AppDelegate` `application(_:didFinishLaunchingWithOptions:)` — UIKit cold-start entry.
- `SceneDelegate` handlers — scene-lifecycle entries.
- URL scheme handler `application(_:open:options:)` — deep-link entry.
- Push notification handler `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`.

### Flutter (Dart)

- `void main()` in `lib/main.dart`.
- `MaterialApp.routes:` map — internal navigation.
- `MethodChannel` registrations — platform-channel handlers bridging native code.
- `app_links.AppLinks().uriLinkStream` — deep-link subscription.
- Background isolate entry points (`@pragma('vm:entry-point') void backgroundHandler()`).

### React Native

- `AppRegistry.registerComponent('app', () => App)`.
- Native module bridge handlers (Objective-C/Swift on iOS, Java/Kotlin on Android).

## Push notification entry-point probes

| Stack | Pattern |
|---|---|
| Firebase Cloud Messaging (Android) | `FirebaseMessagingService` subclass `onMessageReceived` |
| APNs (iOS) | `application(_:didReceiveRemoteNotification:...)` |
| Web Push (Service Worker) | `self.addEventListener('push', ...)` |
| OneSignal / Pusher / etc | SDK-specific handlers; treat as one entry per registered handler |

## WebSocket entry-point probes

| Stack | Pattern |
|---|---|
| Node `ws` | `new WebSocketServer({...}).on('connection', ...)` |
| Socket.io | `io.on('connection', socket => ...)` |
| Phoenix Channels (Elixir) | `channel "topic:*", FooChannel` |
| Django Channels | `channels_routing.py` |
| Cloudflare Workers Durable Objects | `webSocketMessage(ws, message)` handler |

## Lifecycle synthesis output format

For each entry point identified, Phase 6c emits one numbered subsection in `documentation/architecture.md § Request Lifecycles`:

```markdown
### 5.N {Entry-point name}

{One-paragraph description of when this fires}

\`\`\`
{Entry-point trigger}
  └─► {Step 1}
       ├─ {Substep / branch}
       └─ {Substep}
       │
       ▼
{Step 2 (next module)}
  ├─ {happy path arrow}
  └─ {failure transition arrow with target state}
\`\`\`

Implements [REQ-X-NNN](../sdd/{domain}.md#req-x-nnn-...).
```

The ASCII block is constructed from `mcp__graphify__shortest_path(<entry-label>, <terminal-write-node>)` results, augmented by failure-transition discovery via `get_neighbors(<entry-label>)` filtered to error-shaped node names. Where graphify can't resolve a clean path, fall back to a numbered step list without ASCII art (don't fabricate flow).

## Routing-config parsing for Pass 6d

After entry-point identification, Phase 6d enumerates HTTP routes. Per stack:

- **Filesystem-driven** (Astro, Next.js): walk the routing directory; each file is one entry.
- **Decorator-driven** (Flask, FastAPI, Rocket): grep for the decorator pattern across source.
- **Registration-driven** (Express, gin, chi, actix): build a static call graph for `app.METHOD(path, handler)` patterns. The `path` and `handler` are read at the call site.
- **Macro-driven** (Rails routes.rb, Django urls.py): parse the routing DSL.

For each route discovered, populate the api-reference entry per the template:

- HTTP method + path → heading
- Request shape: handler parameter types (TypeScript inference, Zod schema introspection, Python type hints, Rust extractor types)
- Response shape: handler return type
- Error matrix: walk the handler body for `throw`, `return new Response(..., { status: ... })`, middleware short-circuits
- Cache policy: grep `Cache-Control` headers in handler; default `no-store` for mutating methods
- Auth: middleware chain prefix matching the route
- Implementation: `file:line` of the handler definition
- REQ link: from Phase 6b Source Module Map's Implements column for the handler file
