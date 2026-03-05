# Build a Personal CV Website with Contact Form

Build and deploy a personal CV website on Cloudflare Workers with a Turnstile-protected
contact form. Hono for routing, vanilla HTML/CSS/JS, no frameworks.

## Pages

**Home / CV page** (`GET /`) - Hero section with name, title, and short bio. Work experience
(2-3 entries with company, role, dates, description). Skills grouped by category. Education
(1-2 entries). Link to contact page. Use placeholder content - the user will replace it later.

**Contact page** (`GET /contact`) - Form with name (required), email (required, validated),
and message (required, min 10 chars). Cloudflare Turnstile widget for bot protection. Submit
button with loading state. Success/error feedback shown inline after submission.

**Contact form handler** (`POST /api/contact`) - Validates all fields server-side. Verifies
Turnstile token via Cloudflare's siteverify API. Stores valid submissions in Workers KV.
Returns JSON: `{ success: true }` or `{ success: false, error: "..." }`.

**Messages endpoint** (`GET /api/messages`) - Returns all stored contact form submissions as
JSON array, sorted by timestamp descending (newest first).

**404 page** - Styled "Page Not Found" for unknown routes.

## Design

Responsive from 320px to 1440px. Dark theme with a single accent color. System font stack --
no external font loading. Semantic HTML (proper heading hierarchy, nav, main, section, footer).
Print stylesheet for the CV page that hides nav and contact link.

## Technical Details

- Turnstile secret key stored as a Worker secret (`TURNSTILE_SECRET_KEY`)
- Turnstile site key embedded in the contact page HTML
- KV namespace bound as `MESSAGES` for storing submissions
- For local development, use Turnstile test keys:
  - Site key: `1x00000000000000000000AA` (always passes)
  - Secret key: `1x0000000000000000000000000000000AA` (always passes)

## Development Approach

TDD: write failing tests first, then implement. All tests pass before deployment.
