/**
 * Codeflare Pi native Browser Run wrapper (REQ-BROWSER-003).
 *
 * Pi does not consume MCP servers, so Browser Run is exposed as NATIVE Pi tools
 * (mirroring how the first-party graphify-native.ts ships graphify_* tools) instead
 * of via chrome-devtools-mcp the way Claude Code is wired. These tools call Cloudflare
 * Browser Run's REST "Quick Actions" — a real headless Chrome that renders the
 * page with JavaScript executed — so the agent can fall back to it when the
 * built-in web fetch is blocked by bot protection, login walls, redirect chains,
 * or JS-only rendering.
 *
 * Gating: registers NOTHING unless CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
 * are present (the token must carry the "Browser Rendering - Edit" scope). The
 * extension is also only seeded in advanced session mode (preseed manifest), so a
 * default-mode or token-less session is byte-identical to today.
 */
import { Type } from "typebox";

// Pi extension SDK surface, declared inline rather than imported from
// "@earendil-works/pi-coding-agent" so this file needs no Pi SDK installed in
// Codeflare's repo (mirrors codeflare-pi.ts / local-statusline.ts). The real SDK
// types are richer; only the members used here are modelled. registerTool + the
// tool/result shapes follow the Pi SDK docs/extensions.md.
type ToolContent = { type: "text"; text: string };
type AgentToolResult = { content: ToolContent[]; details?: unknown; isError?: boolean };
type ExtensionAPI = { registerTool(tool: unknown): void };

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
// Browser Run can return very large pages; cap tool output so a single fetch
// cannot blow up the agent's context window. Truncation is flagged in the text.
const MAX_OUTPUT_CHARS = 120_000;

const WaitUntil = Type.Optional(
  Type.Union(
    [Type.Literal("load"), Type.Literal("networkidle0"), Type.Literal("networkidle2")],
    {
      description:
        "Page-load wait strategy. Use 'networkidle0' for JS-heavy / single-page apps that render content after the initial load.",
    },
  ),
);

function truncate(text: string): string {
  // Fast path: UTF-16 length <= cap implies code-point count <= cap, so the
  // string is safely under budget and needs no slicing.
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  // Slice on code points (not UTF-16 units) so we never cut a surrogate pair in
  // half on emoji/CJK-heavy pages.
  const chars = Array.from(text);
  if (chars.length <= MAX_OUTPUT_CHARS) return text;
  return `${chars.slice(0, MAX_OUTPUT_CHARS).join("")}\n\n[... truncated ${
    chars.length - MAX_OUTPUT_CHARS
  } chars; narrow the request or use browser_scrape with a CSS selector ...]`;
}

// A successful-but-empty render is usually a JS-heavy page that had not painted
// by capture time. Return an actionable hint instead of an empty string.
function emptyRenderResult(url: string): AgentToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Browser Run returned an empty page for ${url}. The page likely renders content after load — retry with wait_until: "networkidle0".`,
      },
    ],
    details: { url, empty: true },
  };
}

export default function (pi: ExtensionAPI) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  // No Cloudflare credentials -> no Browser Run. Registering nothing keeps a
  // token-less (or non-advanced) session byte-identical to today.
  if (!token || !accountId) return;

  const endpoint = (action: string): string =>
    `${API_BASE}/${accountId}/browser-rendering/${action}`;

  async function quickAction(
    action: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    try {
      const res = await fetch(endpoint(action), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; result?: unknown; errors?: unknown }
        | null;
      if (!res.ok || !data || data.success === false) {
        const detail = data ? JSON.stringify(data.errors ?? data) : `HTTP ${res.status}`;
        return { ok: false, error: `Browser Run /${action} failed: ${detail}` };
      }
      return { ok: true, result: data.result };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return { ok: false, error: "aborted" };
      return {
        ok: false,
        error: `Browser Run /${action} request error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  function gotoOptions(waitUntil?: string): Record<string, unknown> {
    return waitUntil ? { gotoOptions: { waitUntil } } : {};
  }

  function errorResult(message: string): AgentToolResult {
    return { content: [{ type: "text", text: message }], isError: true, details: {} };
  }

  // browser_markdown ---------------------------------------------------------
  pi.registerTool({
    name: "browser_markdown",
    label: "Browser Run: Markdown",
    description:
      "Fetch a public web page through a real headless browser (Cloudflare Browser Run) and return it as clean Markdown. Use as a fallback when the built-in web fetch is blocked by bot protection, login walls, redirects, or JS-only rendering.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute public URL to fetch (https://...)." }),
      wait_until: WaitUntil,
    }),
    promptGuidelines: [
      "Prefer the built-in web fetch first; reach for browser_markdown only when it fails or returns no usable content.",
      "Public URLs only — no internal or authenticated targets.",
      "For JS-heavy or single-page apps, pass wait_until: 'networkidle0'.",
    ],
    async execute(
      _id: string,
      params: { url: string; wait_until?: string },
      signal: AbortSignal,
    ): Promise<AgentToolResult> {
      const r = await quickAction("markdown", { url: params.url, ...gotoOptions(params.wait_until) }, signal);
      if (!r.ok) return errorResult(r.error);
      const text = String(r.result ?? "");
      if (text.trim() === "") return emptyRenderResult(params.url);
      return { content: [{ type: "text", text: truncate(text) }], details: { url: params.url } };
    },
  });

  // browser_content ----------------------------------------------------------
  pi.registerTool({
    name: "browser_content",
    label: "Browser Run: HTML",
    description:
      "Fetch the fully-rendered HTML of a public web page through a real headless browser (Cloudflare Browser Run), after JavaScript has executed. Use when Markdown loses structure you need, or to inspect the DOM of a JS-rendered page.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute public URL to fetch (https://...)." }),
      wait_until: WaitUntil,
    }),
    promptGuidelines: [
      "Prefer browser_markdown for reading content; use browser_content when you need the raw HTML/DOM.",
      "Public URLs only.",
    ],
    async execute(
      _id: string,
      params: { url: string; wait_until?: string },
      signal: AbortSignal,
    ): Promise<AgentToolResult> {
      const r = await quickAction("content", { url: params.url, ...gotoOptions(params.wait_until) }, signal);
      if (!r.ok) return errorResult(r.error);
      const text = String(r.result ?? "");
      if (text.trim() === "") return emptyRenderResult(params.url);
      return { content: [{ type: "text", text: truncate(text) }], details: { url: params.url } };
    },
  });

  // browser_scrape -----------------------------------------------------------
  pi.registerTool({
    name: "browser_scrape",
    label: "Browser Run: Scrape",
    description:
      "Extract specific elements from a public web page by CSS selector through a real headless browser (Cloudflare Browser Run). Returns the text, inner HTML, and attributes of each matched element. Use to pull structured data (headings, links, prices, tables) without ingesting the whole page.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute public URL to scrape (https://...)." }),
      selectors: Type.Array(Type.String({ description: "A CSS selector, e.g. 'h1', 'a', '.price'." }), {
        description: "CSS selectors to extract; each is returned as a separate result group.",
        minItems: 1,
      }),
      wait_until: WaitUntil,
    }),
    promptGuidelines: [
      "Use specific selectors to keep results small.",
      "For JS-heavy pages, pass wait_until: 'networkidle0' so content has rendered before scraping.",
      "Public URLs only.",
    ],
    async execute(
      _id: string,
      params: { url: string; selectors: string[]; wait_until?: string },
      signal: AbortSignal,
    ): Promise<AgentToolResult> {
      const elements = params.selectors.map((selector) => ({ selector }));
      const r = await quickAction("scrape", { url: params.url, elements, ...gotoOptions(params.wait_until) }, signal);
      if (!r.ok) return errorResult(r.error);
      return {
        content: [{ type: "text", text: truncate(JSON.stringify(r.result, null, 2)) }],
        details: { url: params.url, selectors: params.selectors },
      };
    },
  });
}
