---
name: browser-run
description: Read or drive public web pages with a real headless browser (Cloudflare Browser Run). Two surfaces — cheap one-shot Markdown/HTML/scrape via the native browser_markdown / browser_content / browser_scrape tools, and the interactive chrome-devtools browser reached through the pi-mcp-adapter `mcp` proxy (navigate / click / screenshot). Use when the built-in web fetch is blocked or when you need to interact with a page.
---

# Browser Run (Pi)

A real headless browser (Cloudflare Browser Run, headless Chrome) for public web pages that the built-in web fetch can't read or that you need to *interact* with. There are **two surfaces**, and picking the cheaper one is the point — a real browser session is the most expensive way to touch a page.

| Surface | Tools | Cost | Use it for |
|---|---|---|---|
| **Markdown / read** (one-shot) | native `browser_markdown`, `browser_content`, `browser_scrape` | Cheap — one request, no live session | **Reading** a page: article/doc content, verifying rendered text/structure, pulling specific elements. The default when you just need to *see what the page says*. |
| **Interactive** | `chrome-devtools` via the `mcp` proxy (`navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `evaluate_script`, `resize_page`) | Expensive — opens a remote Chrome/CDP session | **Driving** a page: multi-step flows, clicking/typing, screenshots, viewport testing, e2e. |

Both are Pro (advanced) only, and only when a Cloudflare API token with the **Browser Rendering – Edit** scope is configured. If the native `browser_*` tools are absent, Browser Run is not enabled for this session.

## Decision order (cheapest that does the job)

1. **Find pages on the web** → `web_search` (pi-web-access), not Browser Run.
2. **Static / normal page** → `ctx_fetch_and_index` (context-mode, on by default; keeps bytes out of context) or `fetch_content` (pi-web-access). Plain HTTP, no JS — fast and cheap.
3. **Raw HTTP / JSON API** → `curl`.
4. **Blocked or JS-only, but you only need to READ it** → `browser_markdown` (clean Markdown — smallest, best for content), `browser_content` (rendered HTML/DOM), or `browser_scrape` (specific CSS selectors). One-shot, no session — **prefer this over chrome-devtools whenever you don't need to interact.** Don't retry `curl` on a page you already know needs JS.
5. **You need to INTERACT** — navigate a multi-step flow, click/fill, take a screenshot, test a viewport → drive `chrome-devtools` through the `mcp` proxy (see the `pi-mcp-adapter` skill for the proxy mechanics; list its tools, then call them). This is where e2e lives; see the `browser-e2e` skill.
6. Public URLs only. Never point Browser Run at internal hosts, `localhost`, private IPs, or anything requiring the user's session/credentials.

## Read tools

| Tool | Use it for |
|---|---|
| `browser_markdown` | The default. Returns the page as clean Markdown — best for reading article/doc content. |
| `browser_content` | Returns the fully-rendered HTML (after JS). Use when you need raw DOM/structure that Markdown drops. |
| `browser_scrape` | Returns text + HTML + attributes for specific CSS selectors. Use to pull structured bits without ingesting the whole page. |

All three take `url` and an optional `wait_until`. For JS-heavy pages or SPAs, pass `wait_until: "networkidle0"` so content has rendered before capture.

## Notes

- Output is capped (~120k chars) to protect the context window; narrow with `browser_scrape` if a page is huge.
- The read tools are one-shot fetches with no state between calls. For multi-step interactive automation (clicking through a flow, screenshots, viewport e2e), use the interactive chrome-devtools surface above — Pi has full parity with Claude here through the adapter.
