---
name: pi-web-access
description: Web search and URL fetching for Pi (tools web_search, fetch_content, get_search_content). The only web SEARCH Pi has. Includes the decision rule for choosing between web_search, ctx_fetch_and_index, curl, and browser-run.
---

# Web Access (Pi)

Provides Pi's web tools:

| Tool | Use it for |
|---|---|
| `web_search` | Search the web for a query. **This is the only web search Pi has** — use it whenever you need to *find* pages/answers, not just fetch a known URL. |
| `fetch_content` | Fetch a known URL inline. Also clones a GitHub repo URL, transcribes a YouTube URL, and extracts PDFs / local video (`prompt:` to ask about media). Large bodies are truncated in the response but stored in full. |
| `get_search_content` | Retrieve the full stored content from a previous `web_search`/`fetch_content` by `responseId`. |

## Decision rule — which fetch tool?

Pick by intent, not habit:

1. **Find something on the web (you don't have the URL)** → `web_search`.
2. **Read a known URL:**
   - **Large page, many pages, or you only want specific facts from it** → `ctx_fetch_and_index` (context-mode, enabled by default), then `ctx_search`. Keeps the raw bytes out of your context — best default for research.
   - **One page you want to read now, or a GitHub repo / YouTube / PDF / local media** → `fetch_content`.
   - **Raw HTTP: JSON APIs, custom headers, auth, non-HTML** → `curl` via bash.
   - **Page only renders with JavaScript, or is bot-protected / login-walled** → the **browser-run** skill (`browser_markdown` etc., advanced sessions only).

## Notes

- Public URLs only. Never point web tools at `localhost`, private IPs, internal hosts, or anything needing the user's session/credentials.
- `web_search` may require a configured search provider; if it returns nothing, fall back to a known-URL `fetch_content`/`ctx_fetch_and_index`.
- Sending a URL to any of these publishes the request to that service — don't fetch sensitive internal links.
