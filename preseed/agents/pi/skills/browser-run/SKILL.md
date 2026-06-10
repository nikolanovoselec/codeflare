---
name: browser-run
description: Use a real headless browser (Cloudflare Browser Run) as a fallback when the built-in web fetch is blocked by bot protection, login walls, redirects, or JavaScript-only rendering. Pi-native tools browser_markdown / browser_content / browser_scrape.
---

# Browser Run (Pi)

A real-browser fallback for fetching public web pages that the built-in web fetch can't read — bot-protected pages, JS-only / single-page apps, redirect chains, and pages that need a real engine to render. Backed by Cloudflare Browser Run (headless Chrome), exposed as **native Pi tools** (no MCP).

Only available in Pro (advanced) sessions when a Cloudflare API token with the **Browser Rendering – Edit** scope is configured. If the tools below are not present, Browser Run is not enabled for this session.

## When to use

Browser Run is the **last resort** — a real Chrome engine is the most expensive way to read a page. Reach for the cheaper tools first, and use Browser Run only when they genuinely can't read it:

1. **Find pages on the web** → `web_search` (pi-web-access), not Browser Run.
2. **Static / normal page** → `ctx_fetch_and_index` (context-mode, on by default; keeps bytes out of context) or `fetch_content` (pi-web-access). Plain HTTP, no JS — fast and cheap.
3. **Raw HTTP / JSON API** → `curl`.
4. **Use Browser Run ONLY when** the page is **JavaScript-only / a SPA** (content materializes after JS runs) or is **bot-protected / CAPTCHA / redirect-walled**, so the plain fetchers above return an error, an anti-bot page, or empty/unrendered HTML. Don't retry `curl` on a page you already know needs JS — go straight to Browser Run.
5. Public URLs only. Never point Browser Run at internal hosts, `localhost`, private IPs, or anything requiring the user's session/credentials.

## Tools

| Tool | Use it for |
|---|---|
| `browser_markdown` | The default. Returns the page as clean Markdown — best for reading article/doc content. |
| `browser_content` | Returns the fully-rendered HTML (after JS). Use when you need raw DOM/structure that Markdown drops. |
| `browser_scrape` | Returns text + HTML + attributes for specific CSS selectors. Use to pull structured bits (links, headings, prices, table cells) without ingesting the whole page. |

All three take `url` and an optional `wait_until`. For JavaScript-heavy pages or SPAs that render content after load, pass `wait_until: "networkidle0"` so the content has rendered before capture.

## Examples

- Read a doc page bot protection blocks: `browser_markdown { "url": "https://example.com/guide" }`
- Inspect a JS-rendered page's DOM: `browser_content { "url": "https://app.example.com", "wait_until": "networkidle0" }`
- Pull every link + heading: `browser_scrape { "url": "https://example.com", "selectors": ["h1", "h2", "a"] }`

## Notes

- Output is capped (~120k chars) to protect the context window; narrow with `browser_scrape` if a page is huge.
- These are one-shot fetches, not an interactive browser session — there is no click/type/navigate state between calls. For multi-step interactive automation, that is out of scope here.
