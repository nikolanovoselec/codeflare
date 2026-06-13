/**
 * Codeflare Pi native Browser Run wrapper (REQ-BROWSER-003).
 *
 * These NATIVE Pi tools (mirroring how the first-party graphify-native.ts ships
 * graphify_* tools) are the CHEAP one-shot read surface of Browser Run: they call
 * Cloudflare Browser Run's REST "Quick Actions" — a real headless Chrome that
 * renders the page with JavaScript executed — so the agent can read a page when
 * the built-in web fetch is blocked by bot protection, login walls, redirect
 * chains, or JS-only rendering. No CDP session, so they are far cheaper than the
 * interactive surface.
 *
 * They are NOT Pi's only Browser Run path: the INTERACTIVE surface (navigate,
 * click, screenshot, viewport) is the chrome-devtools MCP server, which Pi
 * reaches through the pi-mcp-adapter `mcp` proxy (wired in entrypoint.sh into
 * ~/.pi/agent/mcp.json, the same chrome-devtools server Claude Code uses). So Pi
 * has full parity with Claude — read via these native tools, interact via
 * chrome-devtools. See the browser-run / browser-e2e skills for when to use which.
 *
 * The REST/format logic lives in browser-run-helpers.ts (pure, unit-tested); this
 * file is just the typebox tool surface + thin execute() wrappers.
 *
 * Gating: registers NOTHING unless CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
 * are present (the token must carry the "Browser Rendering - Edit" scope). The
 * extension is also only seeded in advanced session mode (preseed manifest), so a
 * default-mode or token-less session is byte-identical to today.
 */
import { Type } from "typebox";
import { executeBrowserAction, type BrowserActionOutcome } from "./browser-run-helpers";

// Pi extension SDK surface, declared inline rather than imported from
// "@earendil-works/pi-coding-agent" so this file needs no Pi SDK installed in
// Codeflare's repo (mirrors codeflare-pi.ts / local-statusline.ts). The real SDK
// types are richer; only the members used here are modelled. registerTool + the
// tool/result shapes follow the Pi SDK docs/extensions.md.
type ToolContent = { type: "text"; text: string };
type AgentToolResult = { content: ToolContent[]; details?: unknown; isError?: boolean };
type ExtensionAPI = { registerTool(tool: unknown): void };

const WaitUntil = Type.Optional(
  Type.Union(
    [Type.Literal("load"), Type.Literal("networkidle0"), Type.Literal("networkidle2")],
    {
      description:
        "Page-load wait strategy. Use 'networkidle0' for JS-heavy / single-page apps that render content after the initial load.",
    },
  ),
);

// Map the runtime-agnostic helper outcome onto a Pi AgentToolResult.
function toAgentResult(outcome: BrowserActionOutcome): AgentToolResult {
  return outcome.isError
    ? { content: [{ type: "text", text: outcome.text }], details: outcome.details, isError: true }
    : { content: [{ type: "text", text: outcome.text }], details: outcome.details };
}

export default function (pi: ExtensionAPI) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  // No Cloudflare credentials -> no Browser Run. Registering nothing keeps a
  // token-less (or non-advanced) session byte-identical to today.
  if (!token || !accountId) return;

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
    async execute(_id: string, params: { url: string; wait_until?: string }, signal: AbortSignal): Promise<AgentToolResult> {
      return toAgentResult(await executeBrowserAction({ tool: "browser_markdown", params, accountId, token, signal }));
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
    async execute(_id: string, params: { url: string; wait_until?: string }, signal: AbortSignal): Promise<AgentToolResult> {
      return toAgentResult(await executeBrowserAction({ tool: "browser_content", params, accountId, token, signal }));
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
      return toAgentResult(await executeBrowserAction({ tool: "browser_scrape", params, accountId, token, signal }));
    },
  });
}
