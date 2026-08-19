# Browser Run Domain Specification

A real-browser capability for advanced-mode agents, backed by Cloudflare Browser Run. It has **two surfaces**, and both agents have **both**: a cheap one-shot **read** surface (clean Markdown / HTML / scrape over the Browser Run REST Quick Actions) and an **interactive** surface (navigate / click / screenshot / viewport over the `chrome-devtools-mcp` server pointed at the Browser Run CDP `/devtools` WebSocket). Claude Code reaches each as MCP servers (`chrome-devtools` + a `browser-run` MCP server); Pi reaches the read surface via a native wrapper extension and the interactive surface via `chrome-devtools` bridged in through the `pi-mcp-adapter`. The result is per-agent parity: either agent can read a page cheaply or drive it interactively, including from a mobile viewport.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Browser Run | Cloudflare's remote headless-Chrome service. Two surfaces are used: the Chrome DevTools Protocol (CDP) `/devtools` WebSocket (for `chrome-devtools-mcp`, the interactive surface) and the REST "Quick Actions" (`/markdown`, `/content`, `/scrape`, the cheap one-shot read surface) |
| chrome-devtools-mcp | The MCP server that exposes the CDP-driven browser to an agent as tools (navigate / click / screenshot / snapshot / viewport). In Codeflare it is registered, only in Pro (advanced) session mode and only when a CF token + account are present, for BOTH agents pointed at the Browser Run CDP endpoint: for Claude Code in `~/.claude.json`, and for Pi in `~/.pi/agent/mcp.json` where the `pi-mcp-adapter` bridges it in |
| Pi native Browser Run wrapper | A Pi extension (`preseed/agents/pi/extensions/browser-run.ts`) that registers native `browser_markdown` / `browser_content` / `browser_scrape` tools calling the Browser Run REST Quick Actions — the cheap one-shot read surface (mirrors how the first-party `graphify-native.ts` ships native `graphify_*` tools). It is a cost/context choice, not a limitation: Pi also has the interactive `chrome-devtools` surface |
| Claude `browser-run` MCP server | A small Claude-side MCP server (`preseed/agents/claude/browser-run-mcp/`, built into the image, registered in `~/.claude.json`) exposing the same `browser_markdown` / `browser_content` / `browser_scrape` REST Quick Actions — the Claude analog of Pi's native wrapper, giving Claude the cheap read surface |
| WebFetch Fallback | The role the read surface plays: when plain WebFetch is blocked (bot protection, login walls, redirect chains, JS-only pages), the agent retries through the real browser to load a public target |
| Browser Rendering Scope | The `Browser Rendering - Edit` Cloudflare API-token permission required for the deployment to drive Browser Run (both the CDP and REST surfaces) |

### Out of Scope

- **Scripted test-runner / fixed-assertion e2e** -- Browser Run is not a Playwright/Cypress replacement for deterministic, repeatable assertions; those stay in the CI suite. Agent-driven *semantic* e2e (drive the user's own deployed app and judge it against intent) IS in scope -- see [REQ-BROWSER-004](#req-browser-004-agent-semantic-e2e-via-browser-run).
- **In-browser code-execution sandbox** -- The browser loads public web targets only; it is not a sandbox for executing user or agent code.
- **Authenticated / private targets** -- Only public targets are loaded; the fallback does not log in to walled sites on the user's behalf.
- **Persistent browser sessions** -- No long-lived browser state, cookie jars, or profiles are retained across sessions. The REST read surface (native Pi tools / Claude `browser-run` MCP server) performs one-shot fetches; the interactive `chrome-devtools` surface holds a session only for the duration of a task (lazy, disconnects on idle), never persisted across sessions.
- **GitHub Copilot wiring** -- Browser Run for Copilot is deferred to a later iteration; this domain wires Claude Code and Pi only.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Agents | Browser Run is wired per agent by native capability in Pro mode: Claude Code through `chrome-devtools-mcp`, Pi through a native extension (see [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)). Each is seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)) |
| Setup | The `Browser Rendering - Edit` scope is included in the user-pasted Cloudflare token template (see [REQ-AGENT-010](agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)) |

---

### REQ-BROWSER-001: Browser Run as a WebFetch Fallback (Claude Code via chrome-devtools-mcp)

**Intent:** When plain WebFetch is blocked, Claude Code must be able to fall back to a real browser to load public web content.

**Applies To:** User

**Acceptance Criteria:**

1. `chrome-devtools-mcp` is registered for Claude Code (in `~/.claude.json`) only in Pro (advanced) session mode AND only when a Cloudflare API token + account id are present; Standard mode and token-less deploys remove restored Codeflare-owned `chrome-devtools` and `browser-run` registrations while preserving unrelated user servers. <!-- @impl: entrypoint.sh::remove_owned_browser_mcp_servers --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring) -->
2. The registration points the MCP server at the Cloudflare Browser Run CDP `/devtools` endpoint, passes the API token as an `Authorization: Bearer` WebSocket header, and invokes the Dockerfile-baked `chrome-devtools-mcp` stable bin whose version is pinned in the image (not `@latest`). <!-- @impl: entrypoint.sh::CDP_WS_ENDPOINT --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring) -->
3. A `browser-run` skill is seeded (advanced mode) that positions the browser as a retry path for WebFetch failures caused by bot protection, login walls, redirect chains, or JS-only pages. <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (advanced + token: keeps the browser-run/browser-e2e skills for both agents) --> <!-- @manual -->
4. The one-shot Browser Run read tools accept only public HTTP(S) targets. Separately authorized interactive Browser Run and deployed `browser-e2e` workflows may navigate, interact, evaluate page scripts, and verify rendered behavior through the credential-gated browser surface. <!-- @impl: preseed/agents/claude/skills/browser-run/SKILL.md::Decision order (cheapest that does the job) --> <!-- @impl: preseed/agents/claude/skills/browser-e2e/SKILL.md::How to use --> <!-- @manual: Exercise one public one-shot read and one authorized interactive verification; confirm private or credential-bearing initial targets remain rejected. -->

**Constraints:**

- The skill is seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)); the MCP server itself is wired in `entrypoint.sh` behind the advanced-mode + Cloudflare-token gate, matching the existing advanced-only MCP gating so Standard sessions are unaffected.
- The token must carry the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)

**Verification:** Automated test ([entrypoint-browser-run-mcp](../../host/__tests__/entrypoint-browser-run-mcp.test.js))

**Status:** Implemented

---

### REQ-BROWSER-002: Browser Rendering Scope in the Cloudflare Token Template

**Intent:** Driving Browser Run requires a Cloudflare API-token permission, so the user-pasted token template must request the `Browser Rendering - Edit` scope.

**Applies To:** User

**Acceptance Criteria:**

1. The Cloudflare token template adds the `Browser Rendering - Edit` scope. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (AC1: the advanced Cloudflare token template grants Browser Rendering - Edit) -->
2. Adding `browser-rendering.write` does not displace any other capability — it is present in the advanced tier and absent from minimal. The full advanced-tier catalog membership is owned by [REQ-AGENT-079](agents.md#req-agent-079-advanced-cloudflare-oauth-tier-scope-catalog). <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (REQ-BROWSER-002: Browser Rendering scope in the Cloudflare token template) -->
3. Tokens created before this scope was added continue to work for all existing functionality (the scope is required only for Browser Run). <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (AC3: backward-compat — non-Browser-Rendering scope set is exactly the known core set) -->

**Constraints:**

- The scope is added to the existing Cloudflare OAuth scope catalog (the advanced tier), following the established scope-string shape.
- The advanced catalog's full membership — including the granular-vs-combined Access choice — is owned by [REQ-AGENT-079](agents.md#req-agent-079-advanced-cloudflare-oauth-tier-scope-catalog); this REQ covers only the presence of `browser-rendering.write` within it.

**Priority:** P2

**Dependencies:** [REQ-AGENT-010](agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-079](agents.md#req-agent-079-advanced-cloudflare-oauth-tier-scope-catalog)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-BROWSER-003: Pi Native Browser Run Wrapper

**Intent:** Pi needs a cheap one-shot read surface for Browser Run — clean Markdown / HTML / scrape without opening an interactive CDP session — exposed as native Pi tools. (This is a cost/context choice, not a limitation: Pi also has the interactive `chrome-devtools` surface, see [REQ-BROWSER-006](#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter).)

**Applies To:** User

**Acceptance Criteria:**

1. A Pi extension registers native `browser_markdown`, `browser_content`, and `browser_scrape` tools that call the Cloudflare Browser Run REST Quick Actions (`/markdown`, `/content`, `/scrape`). <!-- @impl: preseed/agents/pi/extensions/browser-run-helpers.ts::executeBrowserAction --> <!-- @test: src/__tests__/lib/browser-run-core.test.ts (browser-run core twins are equivalent (REQ-BROWSER-003 ≡ REQ-BROWSER-005)) -->
2. The extension registers nothing unless `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present, and is seeded only in Pro (advanced) session mode — so Standard mode and token-less deploys are byte-identical to today. <!-- @impl: preseed/agents/pi/extensions/browser-run.ts::default --> <!-- @manual -->
3. Before fetch, the tools reject malformed or credential-bearing URLs, non-HTTP(S) schemes, localhost names, and private, loopback, link-local, or unspecified literal addresses; accepted output is capped and errors surface as tool errors. This initial-target guard does not claim redirect or DNS-rebinding protection. <!-- @impl: preseed/agents/pi/extensions/browser-run-helpers.ts::initialTargetError --> <!-- @impl: preseed/agents/pi/extensions/browser-run-helpers.ts::truncate --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->
4. A `browser-run` skill is seeded (advanced mode) positioning these tools in an explicit web-fetch decision tree as the cheap read step for JS-rendered or bot-blocked pages the agent only needs to READ. <!-- @impl: scripts/agent-seed-core.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

- The extension is a loose Pi extension auto-loaded from `~/.pi/agent/extensions/`, seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)) and baked into `src/lib/agent-seed.generated.ts`; it uses only the Pi-runtime-provided `typebox` import (no new container dependency).
- The token must carry the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-AGENT-007](agents.md#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-BROWSER-004: Agent Semantic e2e via Browser Run

**Intent:** An agent should be able to verify the team's own deployed app by judgment — navigate it in a real browser, observe what actually rendered, and decide whether it meets the acceptance criteria — as a complement to scripted CI e2e that catches the "renders but wrong" class of defect (visual regressions, broken responsive layout, behavior that passes a fixed assertion but is wrong) which selector assertions miss.

**Applies To:** User

**Acceptance Criteria:**

1. A `browser-e2e` skill is seeded (advanced mode) for Claude Code, positioning the interactive `chrome-devtools` surface as a semantic verifier of the user's own deployed app, distinct from the `browser-run` fetch fallback, and requiring a pass/fail verdict per acceptance criterion backed by observed evidence. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
2. Advanced Pi seeds `browser-e2e` for full-flow navigate, click, screenshot, and mobile-resize verification through the MCP proxy; native markdown and scrape tools remain the cheap read-only path, matching Claude capability. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
3. Both skills scope targets to public / deployed URLs (Browser Run is remote and cannot reach localhost or private hosts) and to the user's own app under test, and both state that deterministic invariants remain in the CI suite. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
4. The skills are seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)) and rest on the symmetric Browser Run surfaces — both agents reach the interactive `chrome-devtools` surface (Claude [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), Pi [REQ-BROWSER-006](#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter)) and the cheap read surface (Pi [REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper), Claude [REQ-BROWSER-005](#req-browser-005-claude-browser-run-mcp-server-read-surface-parity)). <!-- @impl: scripts/agent-seed-core.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Constraints:**

- Reuses the existing Browser Run wiring; the only new artifacts are the two skill files plus their manifest entries.
- Gated identically to the rest of Browser Run: advanced mode plus a Cloudflare token carrying the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper), [REQ-BROWSER-005](#req-browser-005-claude-browser-run-mcp-server-read-surface-parity), [REQ-BROWSER-006](#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter)

**Verification:** Automated test ([agent-seed-multi-agent](../../src/__tests__/lib/agent-seed-multi-agent.test.ts))

**Status:** Implemented

---

### REQ-BROWSER-005: Claude browser-run MCP server (read-surface parity)

**Intent:** Claude lacked a clean page→Markdown tool — `chrome-devtools` gives an accessibility snapshot and raw DOM, not the Readability-clean HTML→Markdown that Browser Run's REST `/markdown` produces. Give Claude the same cheap one-shot read surface Pi has natively, so the two agents are symmetric and Claude can do the landing's "open web, distilled to Markdown" trick itself.

**Applies To:** User

**Acceptance Criteria:**

1. A Claude-side MCP server (`preseed/agents/claude/browser-run-mcp/`) exposes `browser_markdown` / `browser_content` / `browser_scrape` tools that call the Cloudflare Browser Run REST Quick Actions, mirroring the Pi native wrapper's behavior (same endpoints, ~120k output cap, empty-render hint, `wait_until`). <!-- @impl: preseed/agents/claude/browser-run-mcp/core.mjs::TOOLS --> <!-- @test: src/__tests__/lib/browser-run-core.test.ts (browser-run core twins are equivalent (REQ-BROWSER-003 ≡ REQ-BROWSER-005)) -->
2. Built into the image and registered in `~/.claude.json` only in Pro (advanced) mode AND when `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` are present; Standard / token-less sessions are byte-identical to today, and the token + account are passed in the server's scoped env. <!-- @impl: entrypoint.sh::configure_consult_llm --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring) -->
3. Before fetch, the tools apply the same initial-target matrix as Pi: malformed or credential-bearing URLs, non-HTTP(S) schemes, localhost names, and private, loopback, link-local, or unspecified literal addresses are rejected with zero fetches. This does not claim redirect or DNS-rebinding protection. <!-- @impl: preseed/agents/claude/browser-run-mcp/core.mjs::initialTargetError --> <!-- @impl: preseed/agents/claude/browser-run-mcp/core.mjs::executeBrowserAction --> <!-- @test: src/__tests__/lib/browser-run-core.test.ts (browser-run core twins are equivalent (REQ-BROWSER-003 ≡ REQ-BROWSER-005)) -->
4. The Claude `browser-run` skill positions this read surface (cheap, one-shot) ahead of the interactive `chrome-devtools` surface in its decision order. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (REQ-BROWSER-005/006: the browser-run skill carries BOTH surfaces for each agent (cheap markdown + interactive chrome-devtools)) --> <!-- @manual -->

**Constraints:**

- The `@modelcontextprotocol/sdk` version is pinned (exact) in the server's `package.json` and shadow-pinned by the `browser-run-mcp` job in `bump-shadow-pins.yml` ([REQ-OPS-020](operations.md#req-ops-020-shadow-pin-version-bump-automation)), following the `consult-llm-mcp` build pattern.
- The token must carry the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template), [REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-BROWSER-006: Pi interactive browser via chrome-devtools through the pi-mcp-adapter

**Intent:** Pi must have the same interactive browser surface as Claude (navigate / click / screenshot / viewport), not only the one-shot read tools. Pi consumes MCP servers via the `pi-mcp-adapter`, so the same `chrome-devtools` server Claude uses is bridged into Pi — giving full parity.

**Applies To:** User

**Acceptance Criteria:**

1. Advanced Pi registers the image-baked Chrome DevTools server against Claude's Browser Run CDP endpoint only with token and account ID, passing WS headers and lazy lifecycle so idle sessions hold no browser. <!-- @impl: entrypoint.sh::PLUGIN_DIR --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring) -->
2. Pi reaches the `chrome-devtools` tools through the `pi-mcp-adapter` `mcp` proxy; the `pi-mcp-adapter` skill is seeded so Pi knows how to drive a bridged server. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
3. The Pi `browser-run` and `browser-e2e` skills name the interactive `chrome-devtools` surface (navigate / click / screenshot / `resize_page`) alongside the native read tools, establishing parity with Claude. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
4. Standard mode and token-less deploys remove a restored Codeflare-owned Pi `chrome-devtools` registration while preserving unrelated user servers; Pi's native read tools ([REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper)) remain unchanged and gated. <!-- @impl: entrypoint.sh::remove_owned_browser_mcp_servers --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring) -->

**Constraints:**

- Same gate as the rest of Browser Run (advanced + a token carrying the `Browser Rendering - Edit` scope); the `chrome-devtools` server is the same Dockerfile-baked `chrome-devtools-mcp` binary Claude uses.
- The merge into `~/.pi/agent/mcp.json` mirrors the existing `consult-llm` Pi merge so it composes with any already-configured servers.

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper), [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)

**Verification:** Automated test ([entrypoint-browser-run-mcp](../../host/__tests__/entrypoint-browser-run-mcp.test.js))

**Status:** Implemented

---

### REQ-BROWSER-007: Enterprise admin-configured Browser Rendering token

**Intent:** In enterprise mode individual users do not manage deploy credentials, so the Cloudflare Browser Rendering token that browser-run needs is configured once by an admin in the Setup wizard and applied to every session — rather than each user pasting their own token into the per-user "Push & Deploy" settings accordion (which is hidden in enterprise). When no token is configured, the entire browser-run surface is withheld from the agents.

**Applies To:** System

**Acceptance Criteria:**

1. Enterprise setup accepts an admin-global Browser Rendering token and account ID. <!-- @impl: src/routes/setup/index.ts::app --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (Browser Rendering token (enterprise admin-global)) -->
2. Configured at-rest encryption protects token storage; otherwise the accepted [AD32](../../documentation/decisions/README.md#ad32-encryption_key-is-optional) plaintext fallback applies. <!-- @impl: src/lib/kv-crypto.ts::encryptAndStore --> <!-- @test: src/__tests__/lib/kv-crypto.test.ts (encryptAndStore / REQ-SEC-006 AC7 (real updates always encrypt directly)) --> <!-- @manual -->
3. Prefill reveals only token presence, and a blank save preserves the existing value. <!-- @impl: src/routes/setup/handlers.ts::handlers --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-BROWSER-007: admin Browser Rendering token prefill (masked)) --> <!-- @manual -->
4. In enterprise mode the per-user "Push & Deploy" deploy-keys settings accordion is not rendered: GitHub is connected via the GitHub panel ([REQ-GITHUB-001](github.md#req-github-001-github-token-capture-and-storage)) and the Cloudflare token is the admin-global Setup value, so no per-user deploy-credential entry is shown. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::ACCORDION_SUBTITLES --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-BROWSER-007: Push & Deploy accordion gating) -->
5. At session start in enterprise mode the container's `CLOUDFLARE_API_TOKEN` is ONLY the non-secret placeholder `'codeflare-enterprise'`, plus the non-secret `CLOUDFLARE_ACCOUNT_ID`. The placeholder is substituted and the GitHub token preserved, so the real Browser Rendering token never enters the container ([REQ-BROWSER-008](#req-browser-008-browser-rendering-token-interception-never-in-the-container)). <!-- @impl: src/lib/browser-render-token.ts::applyEnterpriseBrowserToken --> <!-- @impl: src/container/container-env.ts::buildEnvVars --> <!-- @test: src/__tests__/lib/browser-render-token.test.ts (REQ-BROWSER-008: enterprise + configured sets the PLACEHOLDER (never the real token) + admin account, preserves githubToken) -->
6. When no Browser Rendering token is configured, none of the browser-run surface is seeded to the agents: the `chrome-devtools` + `browser-run` MCP servers are not registered and the Pi native extension registers no tools (already gated). <!-- @impl: entrypoint.sh::PLUGIN_DIR --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring) -->

**Constraints:**

- The admin token is shared across all enterprise users, so it must be scoped to `Browser Rendering - Edit` only ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)); the wizard copy states this.
- The skill-strip mirrors the consult-llm skill removal in `configure_consult_llm` (the same "no provider → no skill" parity, [REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template), [REQ-GITHUB-001](github.md#req-github-001-github-token-capture-and-storage), [REQ-SETUP-006](setup.md#req-setup-006-setup-streams-progress-via-ndjson)

**Verification:** Automated test ([Setup storage](../../src/__tests__/routes/setup-enterprise-groups.test.ts) + [masked prefill](../../src/__tests__/routes/setup/handlers.test.ts) + [placeholder substitution](../../src/__tests__/lib/browser-render-token.test.ts) + [container placeholder-only](../../src/__tests__/container/container-env-llm.test.ts) + [admin UI](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) + [accordion hidden](../../web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx) + [skill strip](../../host/__tests__/entrypoint-browser-run-mcp.test.js))

**Status:** Implemented

---

### REQ-BROWSER-008: Browser Rendering token interception (never in the container)

**Intent:** The admin Browser Rendering token must never reside in the (untrusted) container, even though browser-run's MCP servers and the Pi extension call the Cloudflare Browser Rendering REST API + CDP WebSocket from inside it. The container runs in authed mode on a non-secret placeholder; the real token is injected worker-side at the `api.cloudflare.com` boundary, scoped to the one wizard-configured account's `/browser-rendering/*` path.

**Applies To:** System

**Acceptance Criteria:**

1. The container's `CLOUDFLARE_API_TOKEN` is the non-secret placeholder `ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER` (`'codeflare-enterprise'`), emitted only when an admin token is configured (else absent → browser-run unregistered per [REQ-BROWSER-007](#req-browser-007-enterprise-admin-configured-browser-rendering-token) AC6). The real token is read worker-side and never written to container env. <!-- @impl: src/lib/browser-render-token.ts::applyEnterpriseBrowserToken --> <!-- @impl: src/lib/browser-render-token.ts::getEnterpriseBrowserCreds --> <!-- @test: src/__tests__/lib/browser-render-token.test.ts (REQ-BROWSER-008: enterprise + configured sets the PLACEHOLDER (never the real token) + admin account, preserves githubToken) -->
2. A Worker-side browser interceptor is wired in enterprise mode, whenever an admin token and account are configured, for `api.cloudflare.com`, INDEPENDENT of the strict-egress toggle so browser-run works in every enterprise configuration; the per-host registration takes precedence over the strict-egress `'*'` catch-all. <!-- @impl: src/container/container-interception.ts::browserRendering --> <!-- @impl: src/cloudflare-browser-interceptor.ts::CloudflareBrowserInterceptor --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (strips the placeholder + injects the real token on the configured account path, egress DIRECT (not Gateway)) -->
3. On the TRUSTED path `api.cloudflare.com/client/v4/accounts/<acct>/browser-rendering/*` where `<acct>` equals the wizard-configured Browser Rendering account id the interceptor strips the placeholder `authorization` and injects the real token (`Bearer`), egressing direct. <!-- @impl: src/cloudflare-browser-interceptor.ts::CloudflareBrowserInterceptor --> <!-- @impl: src/cloudflare-browser-interceptor.ts::isBrowserRenderingPath --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-BROWSER-008: CloudflareBrowserInterceptor CDP WebSocket) -->
4. EVERY other `api.cloudflare.com` request a different account id, or any non-`browser-rendering` path is NOT injected: forwarded through the strict-egress binding for inspection when strict egress is on, else rejected `403`. <!-- @impl: src/cloudflare-browser-interceptor.ts::CloudflareBrowserInterceptor --> <!-- @impl: src/cloudflare-browser-interceptor.ts::isBrowserRenderingPath --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-BROWSER-008: CloudflareBrowserInterceptor REST path) -->

**Constraints:**

- Mirrors the GitHub interception pattern: placeholder in container, real credential stamped at the boundary; the trusted account is bound in session-scoped configuration, never read from the request (no request can widen the injection to another account).
- Wired only when an admin Browser Rendering token + account are configured; otherwise no placeholder is emitted and there is no `api.cloudflare.com` traffic to intercept.
- The `CloudflareBrowserInterceptor` serves **two modes** on `api.cloudflare.com`, discriminated by props: this enterprise mode (fixed admin token, `/browser-rendering/*`-scoped) and the `!isEnterpriseMode`-guarded non-enterprise OAuth mode ([REQ-AGENT-078](agents.md#req-agent-078-cloudflare-oauth-token-refreshed-at-the-apicloudflarecom-boundary)), which never coexist.
- The Workers Browser Rendering binding (`env.BROWSER`) cannot replace this: it is in-Worker-only and exposes no browser-level CDP WebSocket, which `chrome-devtools-mcp` (running in the container) requires ([REQ-BROWSER-006](#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-007](#req-browser-007-enterprise-admin-configured-browser-rendering-token), [REQ-ENTERPRISE-004](enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)

**Verification:** Automated test ([interceptor tests](../../src/__tests__/cloudflare-browser-interceptor.test.ts) (account-scoped REST + CDP WS injection, rest→Gateway, fail-closed) + [container placeholder](../../src/__tests__/container/container-env-llm.test.ts) + [worker-side resolver](../../src/__tests__/lib/browser-render-token.test.ts))

**Status:** Implemented

---
