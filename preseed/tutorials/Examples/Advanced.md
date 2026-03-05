# Public Blog on Cloudflare Workers

Build a public blog platform using Astro deployed to Cloudflare Workers. The blog has two
faces: a fast, public-facing site for readers and a protected management area for the author.
View counts are tracked with Durable Objects so they survive redeploys and scale without a
database.

## Development Approach

TDD: write failing tests first, then implement. All tests pass before considering a section
complete.

## Stack and Constraints

Astro with SSR via @astrojs/cloudflare adapter. Cloudflare Workers with Wrangler for local
dev. Durable Objects for view counting (SQLite-backed). R2 bucket bound as BLOG_IMAGES for
image storage. KV namespace bound as BLOG_KV for posts. Cloudflare Access for management
area auth. TypeScript strict mode. No client-side JS frameworks - vanilla JS where
interactivity is needed.

The ViewCounter Durable Object class must be exported from the worker entry point. Astro's
build output won't do this automatically - you'll need a custom entry wrapper that re-exports
both the Astro worker and the DO class. Wrangler must use `new_sqlite_classes` (not
`new_classes`) for DO migrations. Access Astro bindings via `Astro.locals.runtime.env`.

## Public Blog Pages

Home page (`/`) lists published posts sorted by date descending. Each entry shows title, date,
excerpt (first 160 chars), and thumbnail. Paginate at 10 posts per page with prev/next links
via `?page=N`. For performance, maintain a `posts:index` KV key with summary data instead of
fetching every post individually - update this index on every create/update/delete. Draft
posts (published: false) must never appear on public pages.

Single post page (`/posts/[slug]`) fetches the post by slug from KV, renders markdown to HTML
(use marked or remark), and shows title, author, date, tags, and an image gallery of
associated images (lazy-loaded). View counter is fetched server-side and incremented
client-side on page load. Unknown slugs return 404 with a friendly message.

Static about page (`/about`). Gallery page (`/gallery`) showing images across all posts.

Shared base layout with nav (Home, Gallery, About), footer, dark theme with CSS custom
properties. Responsive: single column below 768px, two-column grid above. Nav highlights
current page with `aria-current="page"`. Home page renders with SSR - no client-side JS
required for content.

## View Counter (Durable Objects)

ViewCounter DO class with a simple counter stored via `this.ctx.storage.get("count")`.
GET returns `{ slug, count }`, POST increments by 1 and returns the same shape. Each post
gets its own isolated DO instance via `idFromName(slug)`.

Worker API: `GET /api/views/:slug` and `POST /api/views/:slug` proxy to the DO stub.
A never-viewed slug returns `{ slug, count: 0 }`. Counters persist across redeploys.
Concurrent increments must not be lost - 20 simultaneous POSTs must result in count 20.

## Image Upload and R2 Storage

`POST /api/upload` accepts multipart with an "image" field and a "slug" field to associate
the image with a post. Allowed types: JPEG, PNG, WebP, GIF. Max 10MB (reject with 413).
Non-image types rejected with 400. Stored in R2 with correct content-type metadata. Returns
`{ url, key, size, contentType }`.

`GET /images/[...key]` serves images from R2 with immutable cache headers
(`Cache-Control: public, max-age=31536000, immutable`). 404 if not found.

Posts include an `images: string[]` field (R2 keys). After upload, the key is appended to
the post's images array in KV. Deleting a post must also delete its images from R2.

## Protected Management Area

Cloudflare Access protects `/admin/*`, `/api/posts`, and `/api/upload`. Middleware reads the
`CF_Authorization` cookie, verifies the JWT signature, expiration, and audience claim against
the Access JWKS endpoint, and extracts the user email for author attribution. Invalid or
missing JWT returns 401 for API routes and redirects to Access login for pages. Team domain
and audience tag configured via environment variables.

Admin pages (server-rendered): dashboard at `/admin` (post count, total views, recent posts),
post list at `/admin/posts` with edit/delete, create form at `/admin/posts/new`, edit form at
`/admin/posts/[slug]`, and image upload at `/admin/upload` with drag-and-drop.

Create/edit form has title, slug (auto-generated from title, editable), content (textarea),
tags (comma-separated), published checkbox, associated images with drag-to-upload, and a
markdown preview panel.

Post CRUD API: `GET /api/posts` (list, admin sees drafts), `GET /api/posts/:slug`,
`POST /api/posts` (create), `PUT /api/posts/:slug` (update), `DELETE /api/posts/:slug`
(cascades to R2 images). All mutations update the `posts:index` KV key.

Post schema in KV (key `post:{slug}`): slug, title, content (raw markdown), excerpt
(auto-generated, first 160 chars stripped of markdown), tags[], author (email from JWT),
images[] (R2 keys), published (boolean), publishedAt (ISO 8601, set on first publish, never
changed after), updatedAt, createdAt.

Slug generation: lowercase, replace non-alphanumeric with hyphens, collapse multiples, trim
edges. "My First Post!" becomes "my-first-post". "Hello, World! #1" becomes "hello-world-1".

Editing a post preserves its original publishedAt. Deleting cascades to R2 images and updates
posts:index.

## Navigation and SEO

Responsive nav: horizontal on desktop, hamburger on mobile (vanilla JS toggle). Active link
via `aria-current="page"`. Skip-to-content link for accessibility.

Every page gets a unique `<title>` and `<meta name="description">`. Post pages get Open Graph
tags (og:title, og:description, og:image using the first post image or a fallback). Canonical
URLs on all pages. RSS feed at `/rss.xml` (published posts only, valid XML). Sitemap at
`/sitemap.xml` covering `/`, `/about`, `/gallery`, and all published post URLs.
