# Browse the Web (Experimental)

Fetch https://developers.cloudflare.com/agents/api-reference/browse-the-web/ for complete documentation.

CDP-powered browser tools that let agents scrape, screenshot, and interact with web pages.

## Agents 0.31 migration

For new integrations read the [version-matched persistent-browser guide](https://github.com/cloudflare/agents/blob/agents%400.31.0/docs/agents/browse-the-web.md#persistent-browser). Prefer `browserTool({ browser: this.browser, loader: this.env.LOADER })`; use `browser.cdp({ method: "Page.navigate", params: { url }, sessionId: "active" })` inside its model code. It runs code in a fresh Dynamic Worker, without a `ctx` option or its own `CodemodeRuntime` export. Keep `LOADER` and `@cloudflare/codemode` for this release; remove `CodemodeRuntime` only when no legacy flow still uses it.

Inspect result `notice` instead of `restarted`, `newTabs` or `calls`; `PiBrowserToolDetails` has only `executionId` and `status`. Closing the browser and creating Live View links are unavailable to the tool. `this.browser.session()` is the host-code path to the same browser. Keep authorization and per-conversation scope isolation; shared cookies do not grant permission to replay interrupted writes.

The examples below describe the **deprecated legacy** `createBrowserTools` / connector flow, not the new `browserTool` API. Retain that flow when approval/resume through Live View is required: upstream has no replacement yet. `createBrowserRuntime`, `BrowserConnector` and Quick Actions are also deprecated.

## Legacy setup

```jsonc
// wrangler.jsonc
{
  "browser": { "binding": "BROWSER" },
  "worker_loaders": [{ "binding": "LOADER" }],
  "compatibility_flags": ["nodejs_compat"]
}
```

## Usage with AI SDK

```typescript
import { createBrowserTools } from "agents/browser/ai";

export class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    const browserTools = createBrowserTools({
      browser: this.env.BROWSER,
      loader: this.env.LOADER
    });

    const result = streamText({
      model: openai("gpt-4o"),
      messages: await convertToModelMessages(this.messages),
      tools: { ...myTools, ...browserTools },
      onFinish
    });
    return result.toUIMessageStreamResponse();
  }
}
```

## Available Tools

| Tool | Purpose |
|------|---------|
| `browser_search` | Search the web and return results |
| `browser_execute` | Navigate to URL, execute JS, return results |

The LLM writes async JavaScript IIFEs that run in a fresh browser session.

## When to Use

- Need a real browser (JS rendering, screenshots, interaction) → browser tools
- Just need HTML/API data → use `fetch()` instead (faster, cheaper)

## Low-Level API

```typescript
import { connectBrowser, CdpSession } from "agents/browser";

const browser = await connectBrowser(this.env.BROWSER);
const cdp = new CdpSession(browser);
await cdp.send("Page.navigate", { url: "https://example.com" });
```
