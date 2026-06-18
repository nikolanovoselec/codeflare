---
name: cloudflare-stack
description: This skill should be used when the user wants to "build something", "create a website", "make an app", "start a new project", "I have an idea", "build me a...", "I want to create...", "make me a...", "let's build...", "new project", or describes any idea they want to build from scratch. This skill ensures the technology stack used is compatible with Cloudflare Workers deployment. Use this skill proactively whenever the user describes a new project idea — before writing any code, check that the chosen technologies will work on Cloudflare.
version: 1.0.0
---

# Cloudflare Stack: Build for Deployment

This skill ensures that every new project built in Codeflare uses a technology stack that is compatible with Cloudflare Workers, so the user can deploy it with `/github-cloudflare-ship` when ready.

## Target Audience

Non-technical users who describe what they want to build in plain language. They do not know or care about technology stacks — they just want their idea to work and be deployable.

## When This Skill Applies

This skill applies whenever the user wants to **build something new from scratch**. It does NOT apply when working on existing projects that already have code (those already have a stack chosen).

## Step 1: Discovery — Understand What the User Wants

Before writing any code, have a short conversation to understand the user's idea. This is critical because it allows you to **steer requirements toward what is achievable on Cloudflare** before the user gets attached to an approach that cannot be deployed.

**Use the AskUserQuestion tool to present discovery questions with predefined options.** This is faster and easier for non-technical users than typing. Adapt questions to context — skip ones the user already answered. Ask up to 4 questions at a time.

Example discovery questions (adapt the options to match what the user described):

1. **"Who is this for?"** — Options: "Just me", "Friends & family", "Anyone on the internet"
2. **"What should visitors see?"** — Options: "Photos & images", "Text & articles", "Interactive app", (adapt to their idea)
3. **"Should it save data between visits?"** — Options: "No, just show content", "Yes, user accounts", "Yes, form submissions or uploads"
4. **"What is the vibe?"** — Options: "Simple & clean", "Fun & colorful", "Professional & polished"

The user can always pick "Other" and type a custom answer. Use the answers to shape the tech decisions and scope.

**While listening, mentally map their requirements to Cloudflare capabilities.** If something they describe would traditionally need unsupported tech, **steer the conversation now** — before building:

- User: "I want a social media site with millions of users" → "Let's start with a clean, fast site where people can share posts. We can add features as you grow." (Steer toward static + Workers API + D1, not a massive database-heavy backend.)
- User: "I want real-time video chat" → "Video chat needs specialized services. I can build a site with text chat and messaging — would that work for now?" (WebRTC is possible but complex; steer toward achievable scope.)
- User: "I want to run Python scripts on my site" → "I'll build the same functionality using JavaScript, which will make it run super fast and be easy to put online." (Don't mention Cloudflare limitations — just redirect.)
- User: "I want an online store with payments" → "I can build a product showcase with a checkout flow. For payments, we'll connect to Stripe which handles all the money stuff securely." (Stripe works great with Workers.)

**Summarize back before building:**

"So you want [summary]. It will [key features]. Sound right?"

Wait for confirmation. Then build.

**Key principle:** Never tell the user "that's not possible." Instead, find the closest achievable version and present it positively. Shape the requirements during discovery so the project is always buildable and deployable.

## Step 2: Build with the Right Tech Stack

**Every new project must be deployable to Cloudflare Workers.** This means:

### Supported Technologies

Use these for new projects:

**Static websites (most common for non-technical users):**
- HTML, CSS, JavaScript — the simplest and best default
- No framework needed for simple sites — just HTML files in a `public/` directory
- Deployed as Workers Assets (static file serving)

**Frontend frameworks (when a framework is needed):**
- SolidJS (preferred — fast, simple, Cloudflare-native)
- React (widely supported)
- Vue, Svelte, Astro — all compatible
- Any framework that builds to static HTML/CSS/JS works

**Server-side / API projects:**
- Cloudflare Workers (JavaScript/TypeScript) — runs on Cloudflare's edge
- Hono — lightweight web framework designed for Workers
- itty-router — minimal router for Workers
- Any JavaScript/TypeScript server framework that runs in the Workers runtime

**Full-stack:**
- Static frontend + Workers API backend
- Hono with JSX for server-rendered pages
- Astro with Cloudflare adapter
- SolidStart with Cloudflare adapter

**Data storage (when the project needs persistence):**
- Cloudflare KV — simple key-value storage
- Cloudflare R2 — file/object storage (like S3)
- Cloudflare D1 — SQLite database
- Cloudflare Durable Objects — stateful coordination

### Cloudflare cohort pinning

Four npm packages in the Cloudflare Workers stack drift together and break together — pin them as one cohort resolved at scaffold time:

- `wrangler`
- `@cloudflare/workers-types`
- `@cloudflare/vitest-pool-workers`
- `vitest`

Process during `/sdd init` for any Cloudflare Workers project:

1. Run `npm view wrangler version` → latest wrangler (e.g. `4.x.y`)
2. Run `npm view @cloudflare/vitest-pool-workers peerDependencies` → read the `wrangler` peer range and the `vitest` peer range
3. If the wrangler peer range excludes the latest, step down wrangler to the highest satisfying version. Do NOT upgrade `@cloudflare/vitest-pool-workers` to a newer major that hasn't shipped yet.
4. Read `@cloudflare/workers-types` latest — versions are date-stamped (e.g. `4.20260401.0`); pick the newest release that targets the same wrangler major as chosen above
5. Emit all four as specific carets in `package.json`

Rationale: the resource-constrained container (no-local-builds rule) means peer-resolution surprises surface only in CI. Pinning the cohort at scaffold time prevents Dependabot from opening upgrade PRs that immediately break type checking or the vitest pool worker.

Record the resolved cohort in `documentation/decisions/` as an ADR so future upgrades know what was co-tested together.

The generic version-resolution flow (registry queries, peer-dep cross-check, scaffold-only lockfile carveout) lives in the `spec-driven-development` SKILL → § Dependency version resolution — the cohort pinning above is the Cloudflare-specific addendum.

### NOT Supported — Do Not Use

Never use these technologies for new projects:

- **Python backends** (Django, Flask, FastAPI) — cannot run on Workers
- **Go servers** — cannot run on Workers
- **Ruby/Rails** — cannot run on Workers
- **Java/Spring** — cannot run on Workers
- **PHP** — cannot run on Workers
- **Docker-based deployments** — Workers does not run containers
- **Database servers** (PostgreSQL, MySQL, MongoDB, Redis as server) — use Cloudflare D1/KV/R2 instead
- **Node.js-specific APIs** (fs, child_process, net) — Workers uses a web-standard runtime, not Node.js. Use Workers-compatible alternatives.

### What to Do When the User's Idea Needs Unsupported Tech

If the user describes something that would typically require an unsupported technology, **find the Cloudflare-compatible equivalent**:

| User wants | Instead of | Use |
|---|---|---|
| "A website" | Any backend | Static HTML/CSS/JS with Workers Assets |
| "A website with a database" | PostgreSQL/MySQL | Cloudflare D1 (SQLite) |
| "File uploads" | S3/local storage | Cloudflare R2 |
| "User sessions / real-time" | Redis | Cloudflare KV or Durable Objects |
| "An API" | Express/Django/Flask | Hono on Workers |
| "A full-stack app" | Next.js (Node) | SolidStart or Astro with CF adapter |
| "A simple blog" | WordPress | Static HTML or Astro |
| "A web scraper" | Python scripts | Workers with fetch API |
| "AI/chatbot features" | Python ML libs | Workers AI or external API calls |

## Project Structure Conventions

**Always create a new project directory** inside `~/workspace/`. Never build directly in the workspace root — it may contain other projects or files that would get mixed in. Use the project name as the directory name (lowercased, hyphenated).

Example: If the user wants to build a meme site, create `~/workspace/meme-site/` and build everything inside it. Then `cd` into it before handing off to `/github-cloudflare-ship`.

### Static site (most common)
```
~/workspace/my-project/
  public/
    index.html
    styles.css
    script.js
  wrangler.toml        (created by /github-cloudflare-ship)
```

### Workers API
```
~/workspace/my-project/
  src/
    index.ts           (or index.js)
  package.json
  wrangler.toml        (created by /github-cloudflare-ship)
```

### Full-stack (static + API)
```
~/workspace/my-project/
  public/
    index.html
    styles.css
    script.js
  src/
    index.ts           (Workers API that also serves static files)
  package.json
  wrangler.toml        (created by /github-cloudflare-ship)
```

## Step 3: After Building — Ask About Publishing

Once the project is built and working, **always ask the user what they want to do with it:**

"Your [website/app/project] is ready! Would you like to:"
- **"Put it online"** — so anyone with the link can see it
- **"Keep it for myself"** — just download it or keep working on it

**If they want to put it online:** Tell them "Let me set that up for you." Make sure the current working directory is the project directory (e.g., `~/workspace/my-project/`), then invoke the `/github-cloudflare-ship` skill. This will guide them through GitHub setup (version control + CI) first, then Cloudflare deployment. The order matters — GitHub/CI must be configured before deployment.

**If they want to keep it:** Tell them "Your project is saved here and you can keep working on it anytime. If you want to download the files, you can use the Storage panel. Whenever you are ready to put it online, just tell me to ship it."

## How the Skills Work Together

1. User describes their idea → **Step 1: Discovery** — understand requirements, steer toward Cloudflare-achievable scope
2. Agent confirms requirements with user → **Step 2: Build** — using Cloudflare-compatible technologies
3. Agent asks if user wants to publish → **Step 3: Post-build** — "put it online or keep it?"
4. If online → **/github-cloudflare-ship** handles GitHub CI setup first, then Cloudflare deployment
5. Result: a live `.workers.dev` URL

This skill owns the entire pre-build and build phase. `/github-cloudflare-ship` owns the infrastructure and deployment phase — including automatically creating D1 databases, R2 buckets, and KV namespaces when the project uses them. If the user has connected their Cloudflare account in Settings > Push & Deploy, `/github-cloudflare-ship` provisions these resources without any manual steps.

## Communication Style

- Never mention "Cloudflare compatibility" or "tech stack" to the user — they do not need to know why you chose HTML over Django.
- Just build what they asked for using the right technologies.
- If the user specifically requests an incompatible technology (e.g., "build me a Django app"), explain gently: "I'll build this as a web app that we can easily put online. I'll use [technology] which will give you the same result and can be deployed with a single command."
- Focus on what the project DOES, not what technology it uses.
- The post-build question should feel natural, not like a tech setup — "Want to put it online?" not "Want to configure CI/CD?"

