---
name: pi-web-access
description: Search the web or fetch URLs; choose direct, indexed, curl, or browser access.
---

# Web Access (Pi)

Provides Pi's web tools:

| Tool | Use it for |
|---|---|
| `web_search` | Search the web for a query. **This is the only web search Pi has** — use it whenever you need to *find* pages/answers, not just fetch a known URL. |
| `source_check` | Verify concrete claims against retrieved passages and produce bounded, machine-readable evidence with source provenance. |
| `fetch_content` | Fetch a known URL inline. Also clones a GitHub repo URL, transcribes a YouTube URL, and extracts PDFs / local video (`prompt:` to ask about media). Large bodies are truncated in the response but stored in full. |
| `get_search_content` | Retrieve bounded slices of stored `web_search`/`fetch_content` results by `responseId`; follow the returned `offset`/`limit` continuation metadata for more. |

## Decision rule — which fetch tool?

Pick by intent, not habit:

1. **Find something on the web (you don't have the URL)** → `web_search`.
2. **Check whether a specific sourced claim is supported** → `source_check`.
3. **Read a known URL:**
   - **Large page, many pages, or you only want specific facts from it** → when context-mode is available, use `ctx_index({ url: "https://…" })` then `ctx_search`; otherwise use `fetch_content` and retrieve stored sections with `get_search_content`. Context-mode is an optimization, never a prerequisite.
   - **One page you want to read now, or a GitHub repo / YouTube / PDF / local media** → `fetch_content`.
   - **Raw HTTP: JSON APIs, custom headers, auth, non-HTML** → `curl` via bash.
   - **Page only renders with JavaScript, or is bot-protected / login-walled** → the **browser-run** skill (`browser_markdown` etc., advanced sessions only).

## 0.45.0 tool compatibility

- For `web_search` and `source_check`, `provider` is now a **string**, not an array. For multiple providers use, for example, `provider: "brave,exa"`; omit it for the configured default. Unknown names now return an error listing valid names rather than silently selecting `auto`. Correct the name from that error; do not silently broaden the request. Existing provider lists in `web-search.json` remain supported—this change is to tool arguments, not a reason to rewrite configuration.
- New extraction mode, providers, routing/classification and model overrides are optional. Do not enable them, configure a gateway, or introduce paid services without explicit opt-in covering external data disclosure and cost. In particular, `fetch_content` extraction is off unless `"extract"` is added to `fetch.allowedModes`; it sends page text to Cloudflare. Availability is not consent to enable it. Preserve the public-URL-only rule below.

## 0.46.0 compatibility

- Cloudflare, SearchApi and Tabstack search are explicit opt-ins, not default `auto`/`all` routes. Hosted Exa/Tabstack fetching also requires provider-order inclusion and `fetchRouting.allowRemoteHostedProviders: true`. Existing credentials alone do not authorize enabling external URL disclosure or paid operations; do not provision services or assume managed credential coverage.
- Node fetch remains default. `fetchContent.curl` is an optional configured executable, not a tool argument or permission to install/enable a bypass. Preserve public-URL checks, redirect/proxy protections and authorized browser fallback; never bypass login or enterprise egress.
- Snippets marked `[provider summary, not page text]` are indirect evidence, not page quotations. PDF fetch now returns extracted text; use bounded `get_search_content` pages for long results.

## Notes

- Public URLs only. Never point web tools at `localhost`, private IPs, internal hosts, or anything needing the user's session/credentials.
- `web_search` may require a configured search provider; if it returns nothing, fall back to known-URL `fetch_content`, or to `ctx_index({ url: "https://…" })` only when context-mode is available.
- Sending a URL to any of these publishes the request to that service — don't fetch sensitive internal links.
