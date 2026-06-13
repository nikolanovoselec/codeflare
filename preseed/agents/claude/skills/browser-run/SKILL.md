---
name: browser-run
description: Read or drive public web pages with a real headless browser (Cloudflare Browser Run). Two surfaces — a cheap one-shot Markdown/HTML/scrape read (browser_markdown / browser_content / browser_scrape) and the interactive chrome-devtools browser (navigate / click / screenshot). Use when WebFetch is blocked by bot protection, login walls, redirects, or JavaScript-only rendering, or when you need to interact with a page.
version: 2.0.0
---

# Browser Run (Claude Code)

A real headless browser (Cloudflare Browser Run, headless Chrome) for public web pages that `WebFetch` can't read or that you need to *interact* with. There are **two surfaces**, and picking the cheaper one is the whole point of this skill — a real browser session is the most expensive way to touch a page.

| Surface | Tools | Cost | Use it for |
|---|---|---|---|
| **Markdown / read** (one-shot) | `browser_markdown`, `browser_content`, `browser_scrape` (the `browser-run` MCP server) | Cheap — one request, no live session | **Reading** a page: article/doc content, verifying rendered text/structure, pulling specific elements. The default when you just need to *see what the page says*. |
| **Interactive** | `mcp__chrome-devtools__*` (`navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `evaluate_script`, `resize_page`/`emulate`) | Expensive — holds a remote Chrome/CDP session | **Driving** a page: multi-step flows, clicking/typing, screenshots, viewport testing, e2e. |

Both are Pro (advanced) only, and only when a Cloudflare API token with the **Browser Rendering – Edit** scope is configured. If you see neither the `browser_*` tools nor `mcp__chrome-devtools__*`, Browser Run is not enabled — fall back to `WebFetch` only.

## Decision order (cheapest that does the job)

1. **Static / normal page** → `WebFetch`, or `ctx_fetch_and_index` (context-mode) when the page is large or you only want specific facts (keeps the bytes out of your context). Fast and cheap.
2. **Raw HTTP / JSON API** → `curl` via Bash.
3. **Blocked or JS-only, but you only need to READ it** → `browser_markdown` (clean Markdown — smallest, best for content), `browser_content` (rendered HTML/DOM), or `browser_scrape` (specific CSS selectors). One-shot, no session — **prefer this over chrome-devtools whenever you don't need to interact.** Don't retry `WebFetch` on a page you already know needs JS.
4. **You need to INTERACT** — navigate a multi-step flow, click/fill, take a screenshot, test a viewport → the `chrome-devtools` browser. This is where e2e lives; see the `browser-e2e` skill.
5. Public URLs only. Never point Browser Run at internal hosts, `localhost`, private IPs, or anything requiring the user's session/credentials.

## How to use

- **Read:** `browser_markdown { "url": "https://example.com/guide" }`. For JS-heavy / SPA pages pass `wait_until: "networkidle0"` so content has rendered. Narrow huge pages with `browser_scrape` + selectors.
- **Interact:** `navigate_page` → `take_snapshot` / `evaluate_script` to observe → `take_screenshot` when a visual is needed → `click` / `fill` to step. Keep a fetch task read-only; full flows belong in `browser-e2e`.

## Notes

- Extract just what you need (markdown, scoped selectors, targeted snapshot) over dumping whole pages — protect the context window. Output is capped (~120k chars).
- The browser is remote (Cloudflare's edge), so it bypasses container egress limits but is still subject to the target site's own access controls.
