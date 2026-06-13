#!/usr/bin/env node
/**
 * Codeflare Browser Run MCP server (Claude Code) — REQ-BROWSER-005.
 *
 * The Claude-side analog of preseed/agents/pi/extensions/browser-run.ts: exposes
 * the Cloudflare Browser Run REST "Quick Actions" (markdown / content / scrape)
 * as MCP tools, so Claude has the SAME cheap one-shot page-read surface Pi has
 * natively. chrome-devtools-mcp gives Claude the *interactive* browser surface;
 * this server gives it the clean HTML->Markdown / scrape surface. With both, the
 * two agents are symmetric: interactive (chrome-devtools) + markdown (REST).
 *
 * This file is the thin MCP/stdio adapter; all REST + format logic lives in
 * core.mjs (pure, unit-tested, a twin of the Pi helper).
 *
 * Gating: entrypoint.sh only registers this server in ~/.claude.json when
 * SESSION_MODE=advanced and CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID are set
 * (the token must carry the "Browser Rendering - Edit" scope). They are passed in
 * via the server's scoped env block.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { TOOLS, TOOL_NAMES, executeBrowserAction } from "./core.mjs";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const server = new Server({ name: "browser-run", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  if (!TOOL_NAMES.has(name)) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  // Parity with the Pi extension's credential self-gate: entrypoint only registers
  // this server when both are present, but fail clearly rather than emit a confusing
  // Cloudflare auth error if it is ever started without them.
  if (!TOKEN || !ACCOUNT_ID) {
    return {
      content: [
        { type: "text", text: "Browser Run is not configured: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set." },
      ],
      isError: true,
    };
  }
  // Forward the request's AbortSignal so a cancelled tool call aborts the fetch.
  const outcome = await executeBrowserAction({
    tool: name,
    params: args,
    accountId: ACCOUNT_ID,
    token: TOKEN,
    signal: extra?.signal,
  });
  return outcome.isError
    ? { content: [{ type: "text", text: outcome.text }], isError: true }
    : { content: [{ type: "text", text: outcome.text }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the stdio loop when run as the entrypoint — importing this module
// (e.g. the Dockerfile build-time smoke test) must not block on stdin.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { server };
