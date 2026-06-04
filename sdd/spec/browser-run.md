# Browser Run Domain Specification

A real-browser WebFetch fallback for advanced-mode agents, backed by Cloudflare Browser Run. Each agent is wired by its native capability: Claude Code via the `chrome-devtools-mcp` MCP server; Pi — which does not consume MCP — via a native wrapper extension over the Browser Run REST Quick Actions.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Browser Run | Cloudflare's remote headless-Chrome service. Two surfaces are used: the Chrome DevTools Protocol (CDP) `/devtools` WebSocket (for `chrome-devtools-mcp`) and the REST "Quick Actions" (`/markdown`, `/content`, `/scrape`) for the Pi native wrapper |
| chrome-devtools-mcp | The MCP server that exposes the CDP-driven browser to an agent as tools. In Codeflare it is registered for Claude Code (in `~/.claude.json`) only in Pro (advanced) session mode, pointed at the Browser Run CDP endpoint |
| Pi native Browser Run wrapper | A Pi extension (`preseed/agents/pi/extensions/browser-run.ts`) that registers native `browser_markdown` / `browser_content` / `browser_scrape` tools calling the Browser Run REST Quick Actions. Used because Pi does not consume MCP servers (mirrors how `@gaodes/pi-graphify` ships native `graphify_*` tools) |
| WebFetch Fallback | The role Browser Run plays: when plain WebFetch is blocked (bot protection, login walls, redirect chains, JS-only pages), the agent retries through the real browser to load a public target |
| Browser Rendering Scope | The `Browser Rendering - Edit` Cloudflare API-token permission required for the deployment to drive Browser Run (both the CDP and REST surfaces) |

### Out of Scope

- **End-to-end / UI testing** -- Browser Run is a content-retrieval fallback, not a test runner; it does not drive the user's own app under test or assert on UI.
- **In-browser code-execution sandbox** -- The browser loads public web targets only; it is not a sandbox for executing user or agent code.
- **Authenticated / private targets** -- Only public targets are loaded; the fallback does not log in to walled sites on the user's behalf.
- **Persistent browser sessions** -- No long-lived browser state, cookie jars, or profiles are retained across sessions. The Pi wrapper performs one-shot fetches, not interactive navigation.
- **GitHub Copilot wiring** -- Browser Run for Copilot is deferred to a later iteration; this domain wires Claude Code and Pi only.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Agents | Browser Run is wired per agent by native capability in Pro mode: Claude Code through `chrome-devtools-mcp`, Pi through a native extension (see [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)). Each is seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)) |
| Setup | The `Browser Rendering - Edit` scope is added to the user-pasted Cloudflare token template (see [REQ-AGENT-010](agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)) |

---

### REQ-BROWSER-001: Browser Run as a WebFetch Fallback (Claude Code via chrome-devtools-mcp)

<!-- @impl: entrypoint.sh -->
<!-- @impl: preseed/agents/claude/skills/browser-run/SKILL.md -->
<!-- @impl: preseed/agents/claude/manifest.json -->

**Intent:** When plain WebFetch is blocked, Claude Code must be able to fall back to a real browser to load public web content.

**Applies To:** User

**Acceptance Criteria:**

1. `chrome-devtools-mcp` is registered for Claude Code (in `~/.claude.json`) only in Pro (advanced) session mode AND only when a Cloudflare API token + account id are present; Standard mode and token-less deploys omit it (byte-identical to today).
2. The registration points the MCP server at the Cloudflare Browser Run CDP `/devtools` endpoint, passing the API token as an `Authorization: Bearer` header via `--wsHeaders`, and pins the `chrome-devtools-mcp` version (not `@latest`).
3. A `browser-run` skill is seeded (advanced mode) that positions the browser as a retry path for WebFetch failures caused by bot protection, login walls, redirect chains, or JS-only pages.
4. The fallback loads public targets only; it does not perform end-to-end testing or execute code in the browser.

**Constraints:**

- The skill is seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)); the MCP server itself is wired in `entrypoint.sh` behind the advanced-mode + Cloudflare-token gate, matching the existing advanced-only MCP gating so Standard sessions are unaffected.
- The token must carry the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)

**Verification:** Manual / review — the wiring is an `entrypoint.sh` gate plus preseeded skill; no automated unit test (runtime-only artifact).

**Status:** Partial

---

<!-- @test: web-ui/src/__tests__/lib/token-scopes.test.ts (Cloudflare scopes describe -> Browser Rendering - Edit scope present in token template + existing scopes unchanged -> AC1..AC3) -->
### REQ-BROWSER-002: Browser Rendering Scope in the Cloudflare Token Template

<!-- @impl: web-ui/src/lib/token-scopes.ts -->

**Intent:** Driving Browser Run requires a Cloudflare API-token permission, so the user-pasted token template must request the `Browser Rendering - Edit` scope.

**Applies To:** User

**Acceptance Criteria:**

1. The Cloudflare token template adds the `Browser Rendering - Edit` scope.
2. The addition is additive: every scope already present in the template remains unchanged.
3. Tokens created before this scope was added continue to work for all existing functionality (the scope is required only for Browser Run).

**Constraints:**

- The scope is added to the existing token-scope tier definitions, following the established `{ key, type }` scope shape.
- No existing scope is removed or renamed.

**Priority:** P2

**Dependencies:** [REQ-AGENT-010](agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/token-scopes.test.ts)

**Status:** Implemented

---

### REQ-BROWSER-003: Pi Native Browser Run Wrapper

<!-- @impl: preseed/agents/pi/extensions/browser-run.ts -->
<!-- @impl: preseed/agents/pi/skills/browser-run/SKILL.md -->
<!-- @impl: preseed/agents/pi/manifest.json -->
<!-- @impl: scripts/generate-agent-seed.mjs -->

**Intent:** The browser fallback must reach Pi, which cannot consume MCP servers, so Browser Run is exposed to Pi as native tools rather than through `chrome-devtools-mcp`.

**Applies To:** User

**Acceptance Criteria:**

1. A Pi extension registers native `browser_markdown`, `browser_content`, and `browser_scrape` tools (via `pi.registerTool`) that call the Cloudflare Browser Run REST Quick Actions (`/markdown`, `/content`, `/scrape`).
2. The extension registers nothing unless `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present, and is seeded only in Pro (advanced) session mode — so Standard mode and token-less deploys are byte-identical to today.
3. The tools load public targets only, cap their output to protect the context window, and surface errors as tool errors rather than throwing.
4. A `browser-run` skill is seeded (advanced mode) positioning these tools as the WebFetch fallback, and the native tool names are added to the Pi tool allowlist in the seed generator so subagents may use them.

**Constraints:**

- The extension is a loose Pi extension auto-loaded from `~/.pi/agent/extensions/`, seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)) and baked into `src/lib/agent-seed.generated.ts`; it uses only the Pi-runtime-provided `typebox` import (no new container dependency).
- The token must carry the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-AGENT-007](agents.md#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** Manual / review — the extension is a Pi-runtime preseed artifact outside the Worker test suite; verified by review and by exercising the tools in an advanced Pi session.

**Status:** Partial

---
