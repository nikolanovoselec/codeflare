# Browser Run Domain Specification

A real-browser WebFetch fallback for MCP-capable agents, backed by Cloudflare Browser Run.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Browser Run | Cloudflare's remote headless-Chrome service, reached over the Chrome DevTools Protocol (CDP) at a `/devtools` endpoint, used here as a real browser the agent can drive |
| chrome-devtools-mcp | The MCP server that exposes the CDP-driven browser to an agent as tools; in Codeflare it is registered only in Pro (advanced) session mode and pointed at the Browser Run CDP endpoint |
| WebFetch Fallback | The role Browser Run plays: when plain WebFetch is blocked (bot protection, login walls, redirect chains, JS-only pages), the agent retries through the real browser to load a public target |
| Browser Rendering Scope | The `Browser Rendering - Edit` Cloudflare API-token permission required for the deployment to drive Browser Run |

### Out of Scope

- **End-to-end / UI testing** -- Browser Run is a content-retrieval fallback, not a test runner; it does not drive the user's own app under test or assert on UI.
- **In-browser code-execution sandbox** -- The browser loads public web targets only; it is not a sandbox for executing user or agent code.
- **Authenticated / private targets** -- Only public targets are loaded; the fallback does not log in to walled sites on the user's behalf.
- **Persistent browser sessions** -- No long-lived browser state, cookie jars, or profiles are retained across sessions.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Agents | chrome-devtools-mcp is registered through the preseed pipeline for MCP-capable agents in Pro mode (see [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)) |
| Setup | The `Browser Rendering - Edit` scope is added to the user-pasted Cloudflare token template (see [REQ-AGENT-010](agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)) |

---

### REQ-BROWSER-001: chrome-devtools-mcp as a WebFetch Fallback

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: src/lib/agent-seed.generated.ts -->

**Intent:** When plain WebFetch is blocked, the agent must be able to fall back to a real browser to load public web content.

**Applies To:** User

**Acceptance Criteria:**

1. chrome-devtools-mcp is registered for the agent only in Pro (advanced) session mode; Standard mode omits it.
2. The registration points the MCP server at the Cloudflare Browser Run CDP `/devtools` endpoint.
3. The fallback is positioned as a retry path for WebFetch failures caused by bot protection, login walls, redirect chains, or JS-only pages.
4. The fallback loads public targets only; it does not perform end-to-end testing or execute code in the browser.

**Constraints:**

- Registration flows through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)); it is not hand-wired per container.
- The mode gating matches the existing advanced-only MCP gating so Standard sessions are unaffected.

**Priority:** P2

**Dependencies:** [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)

**Verification:** Manual check — `src/__tests__/lib/browser-run.test.ts` not yet written

**Status:** Planned

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

**Status:** Planned

---

### REQ-BROWSER-003: chrome-devtools-mcp Wired for MCP-Capable Agents

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @impl: src/lib/agent-seed.generated.ts -->

**Intent:** The browser fallback must reach every agent that can consume MCP, using each agent's native MCP wiring.

**Applies To:** User

**Acceptance Criteria:**

1. Claude Code receives chrome-devtools-mcp through its native MCP server registration.
2. Copilot receives chrome-devtools-mcp through its native MCP server registration.
3. Pi receives chrome-devtools-mcp through its `mcp.json` bridge.
4. Agents that do not support MCP do not receive the registration.

**Constraints:**

- Per-agent wiring follows the existing multi-agent adaptation pipeline ([REQ-AGENT-007](agents.md#req-agent-007-multi-agent-adaptation-pipeline)); no agent-specific code path is added outside the generator.
- Wiring is mode-gated to Pro mode, consistent with [REQ-BROWSER-001](#req-browser-001-chrome-devtools-mcp-as-a-webfetch-fallback).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-chrome-devtools-mcp-as-a-webfetch-fallback), [REQ-AGENT-007](agents.md#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** Manual check — `src/__tests__/lib/browser-run.test.ts` not yet written

**Status:** Planned
