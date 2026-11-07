---
name: browser-run
description: Read public pages with Browser Run or diagnose configured Chrome DevTools MCP navigation; explicit authorization required for owner login.
version: 2.0.0
---

# Browser Run (Claude Code)

A real headless browser (Cloudflare Browser Run, headless Chrome) for public web pages that `WebFetch` can't read or that you need to *interact* with. There are **two surfaces**, and picking the cheaper one is the whole point of this skill — a real browser session is the most expensive way to touch a page.

| Surface | Tools | Cost | Use it for |
|---|---|---|---|
| **Markdown / read** (one-shot) | `browser_markdown`, `browser_content`, `browser_scrape` (the `browser-run` MCP server) | Cheap — one request, no live session | **Reading** a page: article/doc content, verifying rendered text/structure, pulling specific elements. The default when you just need to *see what the page says*. |
| **Interactive** | `mcp__chrome-devtools__*` (`navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `evaluate_script`, `resize_page`/`emulate`) | Expensive — holds a remote Chrome/CDP session | **Driving** a page: multi-step flows, clicking/typing, screenshots, viewport testing, e2e. |

Managed Browser Run is Advanced-only and requires configured Browser Rendering access (**Browser Rendering – Edit**). Discover the read and interactive surfaces independently through the runtime's configured MCP tooling; absence from the initial tool list is not proof of unavailability. A Browser Run API token authorizes the browser service, not owner login to a website.

## Decision order (cheapest that does the job)

1. **Static / normal page** → `WebFetch`, or `ctx_index({ url: "https://…" })` (context-mode) when the page is large or you only want specific facts (keeps the bytes out of your context). Fast and cheap.
2. **Raw HTTP / JSON API** → `curl` via Bash.
3. **Blocked or JS-only, but you only need to READ it** → `browser_markdown` (clean Markdown — smallest, best for content), `browser_content` (rendered HTML/DOM), or `browser_scrape` (specific CSS selectors). One-shot, no session — **prefer this over chrome-devtools whenever you don't need to interact.** Don't retry `WebFetch` on a page you already know needs JS.
4. **You need to INTERACT** — navigate a multi-step flow, click/fill, take a screenshot, test a viewport → the `chrome-devtools` browser. This is where e2e lives; see the `browser-e2e` skill.
5. Public URLs only; never internal hosts, `localhost`, or private IPs. One-shot reads must not import user sessions or credentials. Interactive owner login requires explicit current-user authorization for the public site and flow; follow the boundaries below.

## How to use

- **Read:** `browser_markdown { "url": "https://example.com/guide" }`. For JS-heavy / SPA pages pass `wait_until: "networkidle0"` so content has rendered. Narrow huge pages with `browser_scrape` + selectors.
- **Interact:** `navigate_page` → `take_snapshot` / `evaluate_script` to observe → `take_screenshot` when a visual is needed → `click` / `fill` to step. Keep a fetch task read-only; full flows belong in `browser-e2e`.

## Interactive discovery and recovery

1. Connect/discover the configured `chrome-devtools` MCP server using the runtime's exposed schema; inspect live tool names and input schemas before calls. Do not guess qualified names or arguments. In Pi, use the native `browser-run` override and `pi-mcp-adapter` skill for explicit connection and exact registered direct-tool activation.
2. Call live `list_pages` before assuming page IDs. Reuse an appropriate existing tab and `navigate_page` before attempting `new_page`; create a page only if needed. Treat `No page found` as a stale ID: list again, never reuse a cached tab ID blindly.
3. Use a meaningful bounded long timeout supported by the discovered schema (120000 ms was successful for navigation). If `new_page` aborts, refresh discovery/list pages and try existing-tab navigation rather than repeating creation. Stop if that bounded recovery fails; report the operation, timeout and concrete sanitized error. An abort is not proof of credential expiry or an underlying transport cause.
4. Preserve the configured command, CA, headers, credentials and retention settings. Do not request Pi reload, install `npx @latest`, change npm/symlinks/configuration, patch the SDK, write a custom CDP client, kill browsers/servers, or warm Pi/Enterprise compute sessions as browser recovery. Missing tools do not authorize authentication bypass. Performance traces may send URLs to Google's CrUX service; do not submit private URLs or sensitive traces without authorization.

## Session lifetime and sequencing

Finish long non-browser build and release prerequisites before requesting an OTP. Perform consecutive authorized owner actions in the same live browser context. After an idle interval, obtain live page inventory and verify protected access again; do not assume a cached page ID or prior login still works. Do not use blind keep-alive pings or export sessions to avoid reauthentication.

The managed continuity profile uses `keep_alive=1200000` (twenty-minute provider inactivity), separately from fixed six-minute browser MCP/RPC budgets. Reconnect reuses the retained owner/session/generation/configuration-bound provider reference and existing browser context, not another account session or a fresh isolated context. Real browser activity may keep that provider session alive; acquisition time alone does not prove expiry. Do not add health pings or export cookies/profiles.

Unavailable retained state is reported honestly; a new blank browser is not recovered login. Reconnection never authorizes replay of uncertain mutations or bypass of website expiry/revocation. Verify deployment and client adoption before assuming this profile is active. Historical six-minute context loss did not prove credential expiry or its underlying cause; request fresh authorized login only when current access requires it.

## Authorized public owner login

Only with explicit current-user authorization, navigate the public site in the configured interactive browser. Inspect a bounded DOM projection of input types and button labels only, not full URLs, field values, page dumps, cookies, tokens or challenge metadata. Fill the authorized owner email in the actual form and use **Send login code**. Confirm the verification prompt and its stated validity window before asking for the current code. Use the user-provided code only in that site's actual **Verify** form, submit once, and observe the result; do not replay an uncertain submission or automatically resend codes. Stop for renewed user input if rejected or expired.

Verify the expected application path and, when authorized, a protected owner GET by status only; a login redirect alone is not protected-access proof. Never export sessions/tokens, bypass Access, substitute token API authentication for owner login, or persist email, OTP, token, cookies or challenge URL metadata in docs/logs/artifacts. Authorization to log in does not authorize unrelated protected actions.

## Verified recovery evidence

In the observed Pi session, `new_page` repeatedly aborted at 120000 ms and cached page 2 returned `No page found`. `mcp({connect: "chrome-devtools"})` refreshed the catalog; live `list_pages` returned page 1 (`about:blank`). Reusing that tab with `navigate_page` at 120000 ms reached Cloudflare Access. After explicitly authorized email submission, the prompt confirmed a ten-minute OTP window; a current user-provided code was submitted once through Verify, redirecting to `/app/`. A protected owner GET returned HTTP 200. Observed Chrome DevTools MCP 1.10.1 and adapter 5.3.1 are evidence, not version requirements. No configuration edits or server kill were needed; the underlying abort cause was not proved.

## Notes

- Extract just what you need (markdown, scoped selectors, targeted snapshot) over dumping whole pages — protect the context window. Output is capped (~120k chars).
- Strict Gateway routing covers the configured Browser Run API/CDP transport. Verify remote-browser website networking independently; a Gateway CDP connection proves neither full website-egress coverage nor bypass. Preserve the operator's TLS inspection settings and the target site's access controls.
