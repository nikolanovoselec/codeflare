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
   - **Large page, many pages, or you only want specific facts from it** → when context-mode is available, use `ctx_fetch_and_index` then `ctx_search`; otherwise use `fetch_content` and retrieve stored sections with `get_search_content`. Context-mode is an optimization, never a prerequisite.
   - **One page you want to read now, or a GitHub repo / YouTube / PDF / local media** → `fetch_content`.
   - **Raw HTTP: JSON APIs, custom headers, auth, non-HTML** → `curl` via bash.
   - **Page only renders with JavaScript, or is bot-protected / login-walled** → the **browser-run** skill (`browser_markdown` etc., advanced sessions only).

## Notes

- Public URLs only. Never point web tools at `localhost`, private IPs, internal hosts, or anything needing the user's session/credentials.
- `web_search` may require a configured search provider; if it returns nothing, fall back to known-URL `fetch_content`, or to `ctx_fetch_and_index` only when context-mode is available.
- Sending a URL to any of these publishes the request to that service — don't fetch sensitive internal links.
