# Build a Personal CV Website with a Contact Form

Build and deploy a personal CV site on Cloudflare Workers. Use Hono with plain HTML, CSS, and JavaScript. The public site should feel finished; the message inbox should not be public under any circumstances.

## Pages

**Home / CV page** (`GET /`): Show a name, professional title, short biography, work experience, grouped skills, education, and a link to the contact page. Use obvious placeholder content the owner can replace without hunting through templates.

**Contact page** (`GET /contact`): Show fields for name, email, and message. All are required. Validate the email and require at least ten message characters. Include a Cloudflare Turnstile widget, a loading state, and inline success or error feedback.

**Contact handler** (`POST /api/contact`): Validate every field on the server, verify the Turnstile token through Cloudflare’s siteverify API, and store only valid submissions in Workers KV. Return `{ success: true }` or `{ success: false, error: "..." }` with an appropriate HTTP status.

**Private messages endpoint** (`GET /api/messages`): Protect this route with Cloudflare Access. Return submissions as a JSON array ordered newest first. Missing or invalid authorization must never expose message content.

**Unknown routes**: Return a styled 404 page.

## Design

Support widths from 320px through 1440px. Use a dark theme with one accent color and a system font stack. Keep heading order and landmarks semantic. Add a print stylesheet that removes navigation and contact controls from the CV page. A résumé that prints its hamburger menu has failed a fairly modest test.

## Data and security

- Store the Turnstile secret as Worker secret `TURNSTILE_SECRET_KEY`.
- Embed only the Turnstile site key in public HTML.
- Bind Workers KV as `MESSAGES`.
- Keep stored names, email addresses, and messages out of logs and error responses.
- Use Cloudflare’s published Turnstile test keys during local tests.

## Delivery contract

Write failing behavioral tests first. Cover field validation, Turnstile success and failure, valid storage, private message access, chronological ordering, responsive rendering, and the 404 path. All required tests and CI must pass before deployment.
