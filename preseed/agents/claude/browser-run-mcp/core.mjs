/**
 * Pure Browser Run REST logic for the Claude-side MCP server (REQ-BROWSER-005).
 *
 * This is the byte-for-byte twin of preseed/agents/pi/extensions/browser-run-helpers.ts
 * (the Pi native wrapper's logic). Keeping the logic here — free of the MCP SDK
 * import — lets src/__tests__/lib/browser-run-core.test.ts unit-test it and assert
 * it is equivalent to the Pi twin, so the two runtimes cannot silently drift.
 * index.mjs is the thin SDK adapter over this module.
 */
const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
// Browser Run can return very large pages; cap tool output so a single fetch
// cannot blow up the agent's context window. Truncation is flagged in the text.
export const MAX_OUTPUT_CHARS = 120_000;

export function truncate(text) {
  // Fast path: UTF-16 length <= cap implies code-point count <= cap.
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  // Slice on code points (not UTF-16 units) so we never cut a surrogate pair.
  const chars = Array.from(text);
  if (chars.length <= MAX_OUTPUT_CHARS) return text;
  return `${chars.slice(0, MAX_OUTPUT_CHARS).join("")}\n\n[... truncated ${
    chars.length - MAX_OUTPUT_CHARS
  } chars; narrow the request or use browser_scrape with a CSS selector ...]`;
}

export function gotoOptions(waitUntil) {
  return waitUntil ? { gotoOptions: { waitUntil } } : {};
}

// A successful-but-empty render is usually a JS-heavy page that had not painted
// by capture time. The hint is actionable text, not a thrown error.
export function emptyRenderText(url) {
  return `Browser Run returned an empty page for ${url}. The page likely renders content after load — retry with wait_until: "networkidle0".`;
}

export async function runQuickAction({ accountId, token, action, body, signal, fetchImpl }) {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${API_BASE}/${accountId}/browser-rendering/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.success === false) {
      const detail = data ? JSON.stringify(data.errors ?? data) : `HTTP ${res.status}`;
      return { ok: false, error: `Browser Run /${action} failed: ${detail}` };
    }
    return { ok: true, result: data.result };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ok: false, error: "aborted" };
    return {
      ok: false,
      error: `Browser Run /${action} request error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run one Browser Run tool end to end and return a runtime-agnostic outcome.
 * browser_markdown/browser_content return the page text; an empty render becomes
 * an actionable hint. browser_scrape returns the matched elements as pretty JSON.
 * Errors come back as { isError: true }, never thrown.
 */
export async function executeBrowserAction({ tool, params, accountId, token, signal, fetchImpl }) {
  if (tool === "browser_scrape") {
    const elements = (params.selectors ?? []).map((selector) => ({ selector }));
    const r = await runQuickAction({
      accountId,
      token,
      action: "scrape",
      body: { url: params.url, elements, ...gotoOptions(params.wait_until) },
      signal,
      fetchImpl,
    });
    if (!r.ok) return { text: r.error, isError: true, details: {} };
    return {
      text: truncate(JSON.stringify(r.result, null, 2)),
      details: { url: params.url, selectors: params.selectors },
    };
  }
  const action = tool === "browser_markdown" ? "markdown" : "content";
  const r = await runQuickAction({
    accountId,
    token,
    action,
    body: { url: params.url, ...gotoOptions(params.wait_until) },
    signal,
    fetchImpl,
  });
  if (!r.ok) return { text: r.error, isError: true, details: {} };
  const text = String(r.result ?? "");
  if (text.trim() === "") return { text: emptyRenderText(params.url), details: { url: params.url, empty: true } };
  return { text: truncate(text), details: { url: params.url } };
}

const WAIT_UNTIL = {
  type: "string",
  enum: ["load", "networkidle0", "networkidle2"],
  description:
    "Page-load wait strategy. Use 'networkidle0' for JS-heavy / single-page apps that render content after the initial load.",
};

export const TOOLS = [
  {
    name: "browser_markdown",
    description:
      "Fetch a public web page through a real headless browser (Cloudflare Browser Run) and return it as clean Markdown. The cheap one-shot READ path — use it to read a page's content (far smaller than HTML, no interactive CDP session). Prefer WebFetch first; reach for this when WebFetch is blocked by bot protection, login walls, redirects, or JS-only rendering.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute public URL to fetch (https://...)." },
        wait_until: WAIT_UNTIL,
      },
      required: ["url"],
    },
  },
  {
    name: "browser_content",
    description:
      "Fetch the fully-rendered HTML of a public web page through a real headless browser (Cloudflare Browser Run), after JavaScript has executed. Use when Markdown loses structure you need, or to inspect the DOM of a JS-rendered page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute public URL to fetch (https://...)." },
        wait_until: WAIT_UNTIL,
      },
      required: ["url"],
    },
  },
  {
    name: "browser_scrape",
    description:
      "Extract specific elements from a public web page by CSS selector through a real headless browser (Cloudflare Browser Run). Returns the text, inner HTML, and attributes of each matched element. Use to pull structured data (headings, links, prices, tables) without ingesting the whole page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute public URL to scrape (https://...)." },
        selectors: {
          type: "array",
          items: { type: "string", description: "A CSS selector, e.g. 'h1', 'a', '.price'." },
          minItems: 1,
          description: "CSS selectors to extract; each is returned as a separate result group.",
        },
        wait_until: WAIT_UNTIL,
      },
      required: ["url", "selectors"],
    },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
