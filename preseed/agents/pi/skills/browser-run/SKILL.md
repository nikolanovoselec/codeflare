---
name: browser-run
description: Read public pages with Browser Run or diagnose configured Chrome DevTools MCP navigation; explicit authorization required for owner login.
---

# Browser Run (Pi)

A real headless browser (Cloudflare Browser Run, headless Chrome) for public web pages that the built-in web fetch can't read or that you need to *interact* with. There are **two surfaces**, and picking the cheaper one is the point — a real browser session is the most expensive way to touch a page.

| Surface | Tools | Cost | Use it for |
|---|---|---|---|
| **Markdown / read** (one-shot) | native `browser_markdown`, `browser_content`, `browser_scrape` | Cheap — one request, no live session | **Reading** a page: article/doc content, verifying rendered text/structure, pulling specific elements. The default when you just need to *see what the page says*. |
| **Interactive** | `chrome-devtools` via pi-mcp-extension direct tools (`navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `evaluate_script`, `resize_page`) | Expensive — opens a remote Chrome/CDP session | **Driving** a page: multi-step flows, clicking/typing, screenshots, viewport testing, e2e. |

Managed Browser Run is Advanced-only and requires configured Browser Rendering access (**Browser Rendering – Edit**). Discover the two surfaces independently: absent native `browser_*` read tools do not prove the configured interactive MCP is unavailable. A Browser Run API token authorizes the browser service, not owner login to a website.

## Decision order (cheapest that does the job)

1. **Find pages on the web** → `web_search` (pi-web-access), not Browser Run.
2. **Static / normal page** → use `ctx_fetch_and_index` when context-mode is available; otherwise use `fetch_content` (pi-web-access). Plain HTTP, no JS — fast and cheap. Context-mode is optional.
3. **Raw HTTP / JSON API** → `curl`.
4. **Blocked or JS-only, but you only need to READ it** → `browser_markdown` (clean Markdown — smallest, best for content), `browser_content` (rendered HTML/DOM), or `browser_scrape` (specific CSS selectors). One-shot, no session — **prefer this over chrome-devtools whenever you don't need to interact.** Don't retry `curl` on a page you already know needs JS.
5. **You need to INTERACT** — navigate a multi-step flow, click/fill, take a screenshot, test a viewport → drive `chrome-devtools` through pi-mcp-extension (see the `pi-mcp-adapter` skill: explicitly connect, discover tools, then activate their exact registered names). This is where e2e lives; see the `browser-e2e` skill.
6. Public URLs only; never internal hosts, `localhost`, or private IPs. One-shot reads must not import user sessions or credentials. Interactive owner login requires explicit current-user authorization for the public site and flow; follow the boundaries below.

## Read tools

| Tool | Use it for |
|---|---|
| `browser_markdown` | The default. Returns the page as clean Markdown — best for reading article/doc content. |
| `browser_content` | Returns the fully-rendered HTML (after JS). Use when you need raw DOM/structure that Markdown drops. |
| `browser_scrape` | Returns text + HTML + attributes for specific CSS selectors. Use to pull structured bits without ingesting the whole page. |

All three take `url` and an optional `wait_until`. For JS-heavy pages or SPAs, pass `wait_until: "networkidle0"` so content has rendered before capture.

## Interactive discovery and recovery

1. Read the `pi-mcp-adapter` skill. Activate `mcp_status` through `capability` and inspect the configured server. Activate `mcp_connect` and call `{ name: "chrome-devtools" }`, then discover live tools through `capability` and activate their exact registered names. Inspect live input schemas before calls; do not use old proxy arguments. If connected tools are inactive, activate them rather than assuming reconnect will override exposure policy. Do not guess qualified names or arguments.
2. Call live `list_pages` before assuming page IDs. Reuse an appropriate existing tab and `navigate_page` before attempting `new_page`; create a page only if needed. Treat `No page found` as a stale ID: list again, never reuse a cached tab ID blindly.
3. Use a meaningful bounded long timeout supported by the discovered schema (120000 ms was successful for navigation). If `new_page` aborts, refresh discovery/list pages and try existing-tab navigation rather than repeating creation. Stop if that bounded recovery fails; report the operation, timeout and concrete sanitized error. An abort is not proof of credential expiry or an underlying transport cause.
4. Preserve the configured command, CA, headers, credentials and retention settings. Do not request Pi reload, install `npx @latest`, change npm/symlinks/configuration, patch the SDK, write a custom CDP client, kill browsers/servers, or warm Pi/Enterprise compute sessions as browser recovery. Missing tools do not authorize authentication bypass. Performance traces may send URLs to Google's CrUX service; do not submit private URLs or sensitive traces without authorization.

## Session lifetime and sequencing

Finish long non-browser build and release prerequisites before requesting an OTP. Perform consecutive authorized owner actions in the same live browser context. After an idle interval, obtain live page inventory and verify protected access again; do not assume a cached page ID or prior login still works. Do not use blind keep-alive pings or export sessions to avoid reauthentication.

The configured profile retains `keep_alive=360000` and `requestTimeoutMs: 360000`. The request budget is fixed per call; progress does not extend it. The extension has no idle disconnect; remote Browser Run inactivity and owner authentication are separate layers. Do not add health pings. A failed mutating call is not replayed merely because the transport reconnects; verify its outcome first. After intervening non-browser work, the authenticated tab was unavailable and reconnecting yielded a fresh blank page. This does not prove owner-credential expiry or the underlying abort cause. Preserve configured lifetime settings; request a fresh authorized login only when current access requires it.

## Authorized public owner login

Only with explicit current-user authorization, navigate the public site in the configured interactive browser. Inspect a bounded DOM projection of input types and button labels only, not full URLs, field values, page dumps, cookies, tokens or challenge metadata. Fill the authorized owner email in the actual form and use **Send login code**. Confirm the verification prompt and its stated validity window before asking for the current code. Use the user-provided code only in that site's actual **Verify** form, submit once, and observe the result; do not replay an uncertain submission or automatically resend codes. Stop for renewed user input if rejected or expired.

Verify the expected application path and, when authorized, a protected owner GET by status only; a login redirect alone is not protected-access proof. Never export sessions/tokens, bypass Access, substitute token API authentication for owner login, or persist email, OTP, token, cookies or challenge URL metadata in docs/logs/artifacts. Authorization to log in does not authorize unrelated protected actions.

## Verified recovery evidence

In the observed session, `new_page` repeatedly aborted at 120000 ms and cached page 2 returned `No page found`. Connecting refreshed the catalog; live `list_pages` returned page 1 (`about:blank`). Reusing that tab with `navigate_page` at 120000 ms reached Cloudflare Access. After explicitly authorized email submission, the prompt confirmed a ten-minute OTP window; a current user-provided code was submitted once through Verify, redirecting to `/app/`. A protected owner GET returned HTTP 200. Observed Chrome DevTools MCP 1.10.1 and adapter 5.3.1 are evidence, not version requirements. No configuration edits or server kill were needed; the underlying abort cause was not proved.

## Notes

- Output is capped (~120k chars) to protect the context window; narrow with `browser_scrape` if a page is huge.
- The read tools are one-shot fetches with no state between calls. For multi-step interactive automation (clicking through a flow, screenshots, viewport e2e), use the configured interactive chrome-devtools surface above and its discovered capabilities.
