---
name: browser-run
description: Use a real headless browser (Cloudflare Browser Run, via the chrome-devtools MCP server) as a fallback when WebFetch is blocked by bot protection, login walls, redirects, or JavaScript-only rendering. Activates when WebFetch fails or returns unusable content for a public URL.
version: 1.0.0
---

# Browser Run (Claude Code)

A real-browser fallback for fetching public web pages that `WebFetch` can't read — bot-protected pages, JS-only / single-page apps, redirect chains, and pages that need a real engine to render. Backed by Cloudflare Browser Run (headless Chrome) and exposed through the **`chrome-devtools` MCP server** (registered in `~/.claude.json`).

Only available in Pro (advanced) sessions when a Cloudflare API token with the **Browser Rendering – Edit** scope is configured. If you don't see `chrome-devtools` MCP tools (e.g. `mcp__chrome-devtools__navigate_page`, `take_snapshot`, `take_screenshot`, `evaluate_script`), Browser Run is not enabled for this session — fall back to WebFetch only.

## When to use

1. Try `WebFetch` first — it's faster and cheaper.
2. If `WebFetch` errors, returns a CAPTCHA/anti-bot page, an empty body, or obviously unrendered HTML, **fall back to the `chrome-devtools` browser tools**.
3. Public URLs only. Do not point Browser Run at internal hosts, `localhost`, private IPs, or anything requiring the user's session/credentials.

## How to use

The `chrome-devtools` MCP server drives a remote Chrome over the Chrome DevTools Protocol. Typical flow:

1. `navigate_page` to the target URL (for JS-heavy pages, let it settle / wait for network idle).
2. `take_snapshot` to read the rendered accessibility tree / text content, or `evaluate_script` to pull specific values from the DOM.
3. `take_screenshot` only when a visual is genuinely needed.

Keep it to read-only navigation and extraction — this is a fetch fallback, not an end-to-end testing harness. Don't perform logins, form submissions against third-party sites, or any state-changing actions.

## Notes

- Prefer extracting just the content you need (snapshot/evaluate) over dumping whole pages, to protect the context window.
- The browser is remote (Cloudflare's edge), so it bypasses container egress limits but is still subject to the target site's own access controls.
