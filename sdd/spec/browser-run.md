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
| Setup | The `Browser Rendering - Edit` scope is added to the user-pasted Cloudflare token template (see [REQ-AGENT-010](agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)) |

---

### REQ-BROWSER-001: Browser Run as a WebFetch Fallback (Claude Code via chrome-devtools-mcp)

**Intent:** When plain WebFetch is blocked, Claude Code must be able to fall back to a real browser to load public web content.

**Applies To:** User

**Acceptance Criteria:**

1. `chrome-devtools-mcp` is registered for Claude Code (in `~/.claude.json`) only in Pro (advanced) session mode AND only when a Cloudflare API token + account id are present; Standard mode and token-less deploys omit it (byte-identical to today). <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring describe -> advanced+token registers chrome-devtools for Claude / gating) -->
2. The registration points the MCP server at the Cloudflare Browser Run CDP `/devtools` endpoint, passing the API token as an `Authorization: Bearer` header via `--wsHeaders`, and pins the `chrome-devtools-mcp` version (not `@latest`). <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring describe -> advanced+token registers chrome-devtools for Claude / gating) -->
3. A `browser-run` skill is seeded (advanced mode) that positions the browser as a retry path for WebFetch failures caused by bot protection, login walls, redirect chains, or JS-only pages. <!-- @impl: preseed/agents/claude/skills/browser-run/SKILL.md --> <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring > advanced + token: keeps the browser-run/browser-e2e skills for both agents) -->
4. The fallback loads public targets only; it does not perform end-to-end testing or execute code in the browser. <!-- @impl: preseed/agents/claude/skills/browser-run/SKILL.md --> <!-- coverage-gap: this is a scoping constraint of the browser-run SKILL.md prose; no behavioral test exercises the public-only / no-e2e / no-code-exec boundary (asserting it would require source-string matching of the skill doc, which this repo bans) -->

**Constraints:**

- The skill is seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)); the MCP server itself is wired in `entrypoint.sh` behind the advanced-mode + Cloudflare-token gate, matching the existing advanced-only MCP gating so Standard sessions are unaffected.
- The token must carry the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers), [REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)

**Verification:** [Automated test](../../host/__tests__/entrypoint-browser-run-mcp.test.js) — executes the `entrypoint.sh` Browser Run block with a stubbed advanced + token env and asserts the `chrome-devtools` registration (CDP `/devtools` endpoint, bearer `--wsHeaders`, pinned version) and the gate (nothing registered in default mode or without a token). The `browser-run` skill (AC3/AC4) is asserted present, advanced-mode, and public-scoped by `src/__tests__/lib/agent-seed-manifest.test.ts`.

**Status:** Implemented

---

### REQ-BROWSER-002: Browser Rendering Scope in the Cloudflare Token Template

**Intent:** Driving Browser Run requires a Cloudflare API-token permission, so the user-pasted token template must request the `Browser Rendering - Edit` scope.

**Applies To:** User

**Acceptance Criteria:**

1. The Cloudflare token template adds the `Browser Rendering - Edit` scope. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (advanced tier grants browser-rendering.write; minimal does not) -->
2. The addition is additive: every scope already present in the template remains unchanged. <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (additive: every core scope still present in advanced) -->
3. Tokens created before this scope was added continue to work for all existing functionality (the scope is required only for Browser Run). <!-- @impl: src/lib/oauth-scopes.ts::cloudflareScopeForTier --> <!-- @test: src/__tests__/lib/oauth-scopes.test.ts (backward-compat: non-Browser-Rendering scope set unchanged) -->

**Constraints:**

- The scope is added to the existing Cloudflare OAuth scope catalog (the advanced tier), following the established scope-string shape.
- No existing scope is removed or renamed.

**Priority:** P2

**Dependencies:** [REQ-AGENT-010](agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-BROWSER-003: Pi Native Browser Run Wrapper

**Intent:** Pi needs a cheap one-shot read surface for Browser Run — clean Markdown / HTML / scrape without opening an interactive CDP session — exposed as native Pi tools. (This is a cost/context choice, not a limitation: Pi also has the interactive `chrome-devtools` surface, see [REQ-BROWSER-006](#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter).)

**Applies To:** User

**Acceptance Criteria:**

1. A Pi extension registers native `browser_markdown`, `browser_content`, and `browser_scrape` tools (via `pi.registerTool`) that call the Cloudflare Browser Run REST Quick Actions (`/markdown`, `/content`, `/scrape`). <!-- @impl: preseed/agents/pi/extensions/browser-run-helpers.ts::executeBrowserAction --> <!-- @test: src/__tests__/lib/browser-run-core.test.ts (browser-run core: pi/browser-run-helpers describe -> truncate / runQuickAction / executeBrowserAction) -->
2. The extension registers nothing unless `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present, and is seeded only in Pro (advanced) session mode — so Standard mode and token-less deploys are byte-identical to today. <!-- @impl: preseed/agents/pi/extensions/browser-run.ts --> <!-- coverage-gap: no test exercises the extension's conditional registration guard (no-token -> registers nothing); existing tests cover the action core (browser-run-core.test.ts) and seeded-key presence only, not the token-gated registration path -->
3. The tools load public targets only, cap their output to protect the context window, and surface errors as tool errors rather than throwing. <!-- @impl: preseed/agents/pi/extensions/browser-run-helpers.ts::truncate --> <!-- @test: src/__tests__/lib/browser-run-core.test.ts (browser-run core: pi/browser-run-helpers describe -> truncate / runQuickAction / executeBrowserAction) -->
4. A `browser-run` skill is seeded (advanced mode) positioning these tools in an explicit web-fetch decision tree (pi-web-access → `ctx_fetch_and_index` → `curl` → `browser_markdown`) as the cheap read step for JS-rendered or bot-blocked pages the agent only needs to READ — with the interactive `chrome-devtools` surface as the next step up for pages that must be driven ([REQ-BROWSER-006](#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter)); the native tool names are added to the Pi tool allowlist in the seed generator so subagents may use them. <!-- @impl: scripts/generate-agent-seed.mjs::adaptAgentFrontmatter --> <!-- @impl: preseed/agents/pi/skills/browser-run/SKILL.md --> <!-- @impl: preseed/agents/pi/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (the browser-run skill carries BOTH surfaces for each agent -> pi browser-run skill names browser_markdown + chrome-devtools + Decision order) -->

**Constraints:**

- The extension is a loose Pi extension auto-loaded from `~/.pi/agent/extensions/`, seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)) and baked into `src/lib/agent-seed.generated.ts`; it uses only the Pi-runtime-provided `typebox` import (no new container dependency).
- The token must carry the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-AGENT-007](agents.md#req-agent-007-multi-agent-adaptation-pipeline)

**Verification:** [Automated test](../../src/__tests__/lib/browser-run-core.test.ts) — unit-tests the extension's REST/format core (account/action endpoint + bearer header, the ~120k truncation cap with surrogate safety, the empty-render hint, `browser_scrape` selector→element mapping, and errors surfaced as tool errors rather than thrown). `src/__tests__/lib/agent-seed-manifest.test.ts` asserts the native tools and the `browser-run` skill are seeded for Pi (AC4).

**Status:** Implemented

---

### REQ-BROWSER-004: Agent Semantic e2e via Browser Run

**Intent:** An agent should be able to verify the team's own deployed app by judgment — navigate it in a real browser, observe what actually rendered, and decide whether it meets the acceptance criteria — as a complement to scripted CI e2e that catches the "renders but wrong" class of defect (visual regressions, broken responsive layout, behavior that passes a fixed assertion but is wrong) which selector assertions miss.

**Applies To:** User

**Acceptance Criteria:**

1. A `browser-e2e` skill is seeded (advanced mode) for Claude Code, positioning the interactive `chrome-devtools` surface (navigate / interact / observe / screenshot / measure) as a semantic verifier of the user's own deployed app, distinct from the `browser-run` fetch fallback, and requiring a pass/fail verdict per acceptance criterion backed by observed evidence. <!-- @impl: preseed/agents/claude/skills/browser-e2e/SKILL.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe -> REQ-BROWSER-004 it) -->
2. A dedicated Pi `browser-e2e` skill is seeded (advanced mode) that drives the interactive `chrome-devtools` surface through the `pi-mcp-adapter` `mcp` proxy (navigate / click / `take_screenshot` / `resize_page` for a mobile viewport) for full-flow verification — full parity with Claude — with the native `browser_markdown` / `browser_scrape` tools positioned as the cheap read-only path for content/state checks; it governs the "e2e test &lt;url&gt; from a mobile viewport" task. <!-- @impl: preseed/agents/pi/skills/browser-e2e/SKILL.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe -> REQ-BROWSER-004 it) -->
3. Both skills scope targets to public / deployed URLs (Browser Run is remote and cannot reach localhost or private hosts) and to the user's own app under test, and both state that deterministic invariants remain in the CI suite. <!-- @impl: preseed/agents/claude/skills/browser-e2e/SKILL.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe -> REQ-BROWSER-004 it) -->
4. The skills are seeded through the preseed manifest pipeline ([REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth)) and rest on the symmetric Browser Run surfaces — both agents reach the interactive `chrome-devtools` surface (Claude [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), Pi [REQ-BROWSER-006](#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter)) and the cheap read surface (Pi [REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper), Claude [REQ-BROWSER-005](#req-browser-005-claude-browser-run-mcp-server-read-surface-parity)). <!-- @impl: scripts/generate-agent-seed.mjs --> <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @impl: preseed/agents/pi/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe -> REQ-BROWSER-004 it) -->

**Constraints:**

- Reuses the existing Browser Run wiring; the only new artifacts are the two skill files plus their manifest entries.
- Gated identically to the rest of Browser Run: advanced mode plus a Cloudflare token carrying the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper), [REQ-BROWSER-005](#req-browser-005-claude-browser-run-mcp-server-read-surface-parity), [REQ-BROWSER-006](#req-browser-006-pi-interactive-browser-via-chrome-devtools-through-the-pi-mcp-adapter)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts) — asserts the `browser-e2e` skill is seeded for Claude and Pi (advanced mode) with the correct per-agent surface (both name `chrome-devtools` for the interactive flow and `browser_markdown` for the cheap read path, AC1/AC2), scoped to public/deployed targets with deterministic invariants kept in CI (AC3). The skills rest on the symmetric Browser Run wiring tested under REQ-BROWSER-005/006; their live driving was also dogfooded (this repo's own landing QA was run this way).

**Status:** Implemented

---

### REQ-BROWSER-005: Claude browser-run MCP server (read-surface parity)

**Intent:** Claude lacked a clean page→Markdown tool — `chrome-devtools` gives an accessibility snapshot and raw DOM, not the Readability-clean HTML→Markdown that Browser Run's REST `/markdown` produces. Give Claude the same cheap one-shot read surface Pi has natively, so the two agents are symmetric and Claude can do the landing's "open web, distilled to Markdown" trick itself.

**Applies To:** User

**Acceptance Criteria:**

1. A Claude-side MCP server (`preseed/agents/claude/browser-run-mcp/`) exposes `browser_markdown` / `browser_content` / `browser_scrape` tools that call the Cloudflare Browser Run REST Quick Actions, mirroring the Pi native wrapper's behavior (same endpoints, ~120k output cap, empty-render hint, `wait_until`). <!-- @impl: preseed/agents/claude/browser-run-mcp/core.mjs::TOOLS --> <!-- @impl: preseed/agents/claude/browser-run-mcp/index.mjs --> <!-- @impl: preseed/agents/claude/browser-run-mcp/core.d.mts --> <!-- @impl: preseed/agents/claude/browser-run-mcp/package.json --> <!-- @test: src/__tests__/lib/browser-run-core.test.ts (browser-run core: claude/browser-run-mcp/core describe + twins are equivalent describe) --> <!-- @test: host/__tests__/dockerfile-browser-run-mcp.test.js (Dockerfile Claude browser-run MCP server describe) -->
2. It is built into the image (Dockerfile) and registered in `~/.claude.json` by `entrypoint.sh` only in Pro (advanced) mode AND when `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` are present (Standard / token-less sessions are byte-identical to today), with the token + account passed in the server's scoped env. <!-- @impl: entrypoint.sh --> <!-- @impl: Dockerfile --> <!-- @test: host/__tests__/dockerfile-browser-run-mcp.test.js (Dockerfile Claude browser-run MCP server describe) --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring > advanced + token: registers the Claude browser-run MCP server / no token: nothing registered) -->
3. The tools load public targets only and surface errors as tool errors rather than throwing. <!-- @impl: preseed/agents/claude/browser-run-mcp/core.mjs::executeBrowserAction --> <!-- @test: src/__tests__/lib/browser-run-core.test.ts (browser-run core: claude/browser-run-mcp/core describe + twins are equivalent describe) -->
4. The Claude `browser-run` skill positions this read surface (cheap, one-shot) ahead of the interactive `chrome-devtools` surface in its decision order. <!-- @impl: preseed/agents/claude/skills/browser-run/SKILL.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (the browser-run skill carries BOTH surfaces for each agent -> claude browser-run skill names browser_markdown + chrome-devtools + Decision order) -->

**Constraints:**

- The `@modelcontextprotocol/sdk` version is pinned (exact) in the server's `package.json` and shadow-pinned by the `browser-run-mcp` job in `bump-shadow-pins.yml` ([REQ-OPS-020](operations.md#req-ops-020-shadow-pin-version-bump-automation)), following the `consult-llm-mcp` build pattern.
- The token must carry the `Browser Rendering - Edit` scope ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template), [REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper)

**Verification:** Automated — `src/__tests__/lib/browser-run-core.test.ts` unit-tests the server's REST/format core and the three tool definitions (AC1/AC3) and proves it equivalent to the Pi twin; `host/__tests__/dockerfile-browser-run-mcp.test.js` asserts the image build (COPY + `npm install --omit=dev` + import smoke test + pinned SDK, AC1); `host/__tests__/entrypoint-browser-run-mcp.test.js` asserts the `~/.claude.json` registration and the advanced + token gate (AC2); `src/__tests__/lib/agent-seed-manifest.test.ts` asserts the `browser-run` skill's decision order positions this read surface ahead of chrome-devtools (AC4).

**Status:** Implemented

---

### REQ-BROWSER-006: Pi interactive browser via chrome-devtools through the pi-mcp-adapter

**Intent:** Pi must have the same interactive browser surface as Claude (navigate / click / screenshot / viewport), not only the one-shot read tools. Pi consumes MCP servers via the `pi-mcp-adapter`, so the same `chrome-devtools` server Claude uses is bridged into Pi — giving full parity.

**Applies To:** User

**Acceptance Criteria:**

1. `entrypoint.sh` registers the `chrome-devtools` MCP server in `~/.pi/agent/mcp.json` (pointed at the same Browser Run CDP `/devtools` endpoint as Claude's, same token via `--wsHeaders`) only in Pro (advanced) mode AND when `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` are present; `lifecycle: lazy` so an idle session does not hold a remote browser open. <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring describe -> registers chrome-devtools for Pi in mcp.json with lifecycle lazy / gating) -->
2. Pi reaches the `chrome-devtools` tools through the `pi-mcp-adapter` `mcp` proxy; the `pi-mcp-adapter` skill is seeded so Pi knows how to drive a bridged server. <!-- @impl: preseed/agents/pi/skills/pi-mcp-adapter/SKILL.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe -> REQ-BROWSER-005/006 it + pi-mcp-adapter skill present) -->
3. The Pi `browser-run` and `browser-e2e` skills name the interactive `chrome-devtools` surface (navigate / click / screenshot / `resize_page`) alongside the native read tools, establishing parity with Claude. <!-- @impl: preseed/agents/pi/skills/browser-run/SKILL.md --> <!-- @impl: preseed/agents/pi/skills/browser-e2e/SKILL.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents describe -> REQ-BROWSER-005/006 it + pi-mcp-adapter skill present) -->
4. Standard mode and token-less deploys register nothing (byte-identical to today); Pi's native read tools ([REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper)) are unchanged and remain the cheap path. <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring describe -> registers chrome-devtools for Pi in mcp.json with lifecycle lazy / gating) -->

**Constraints:**

- Same gate as the rest of Browser Run (advanced + a token carrying the `Browser Rendering - Edit` scope); the `chrome-devtools` server is the same pinned `chrome-devtools-mcp` version Claude uses.
- The merge into `~/.pi/agent/mcp.json` mirrors the existing `consult-llm` Pi merge so it composes with any already-configured servers.

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-BROWSER-003](#req-browser-003-pi-native-browser-run-wrapper), [REQ-AGENT-005](agents.md#req-agent-005-pro-mode-includes-additional-skills-rules-agents-and-mcp-servers)

**Verification:** Automated — `host/__tests__/entrypoint-browser-run-mcp.test.js` executes the `entrypoint.sh` block and asserts the `chrome-devtools` server is merged into `~/.pi/agent/mcp.json` with `lifecycle: lazy` at the same CDP endpoint, that existing entries (consult-llm) survive the merge, and that default-mode / token-less sessions register nothing (AC1/AC4). `src/__tests__/lib/agent-seed-manifest.test.ts` asserts the Pi `browser-run` + `browser-e2e` skills name `chrome-devtools` and that the `pi-mcp-adapter` skill is seeded (AC2/AC3).

**Status:** Implemented

---

### REQ-BROWSER-007: Enterprise admin-configured Browser Rendering token

**Intent:** In enterprise mode individual users do not manage deploy credentials, so the Cloudflare Browser Rendering token that browser-run needs is configured once by an admin in the Setup wizard and applied to every session — rather than each user pasting their own token into the per-user "Push & Deploy" settings accordion (which is hidden in enterprise). When no token is configured, the entire browser-run surface is withheld from the agents.

**Applies To:** System

**Acceptance Criteria:**

1. The Setup wizard exposes (enterprise only) an admin-global Cloudflare Browser Rendering token + account id. The token is stored encrypted at rest (the same kv-crypto path as deploy-keys) and is masked on prefill — the wizard learns only whether a token is set, never its value; a blank or masked value on save leaves the stored token in place. <!-- @impl: src/routes/setup/index.ts --> <!-- @impl: web-ui/src/components/setup/ConfigureStep.tsx --> <!-- @test: src/__tests__/routes/setup.test.ts (Feature A/C: enterprise groups chip list + dynamic routes > REQ-BROWSER-007: persists the Browser Rendering token + account id) --> <!-- @test: src/__tests__/routes/setup/handlers.test.ts (REQ-BROWSER-007: admin Browser Rendering token prefill (masked)) --> <!-- @test: web-ui/src/__tests__/components/ConfigureStep.test.tsx (Browser Rendering token (enterprise admin-global)) -->
2. In enterprise mode the per-user "Push & Deploy" deploy-keys settings accordion is not rendered: GitHub is connected via the GitHub panel ([REQ-GITHUB-001](github.md#req-github-001-github-token-capture-and-storage)) and the Cloudflare token is the admin-global Setup value, so no per-user deploy-credential entry is shown. <!-- @impl: web-ui/src/components/SettingsPanel.tsx --> <!-- @test: web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx (REQ-BROWSER-007: Push & Deploy accordion gating) -->
3. At session start in enterprise mode the admin-global token + account id override the (now unused) per-user Cloudflare deploy-key fields and reach the container as `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` via the existing env path; the GitHub token and every other field pass through unchanged. The narrowly-scoped (`Browser Rendering - Edit`) token is permitted in the container env — it grants only Browser Rendering, nothing the agent cannot already do through its own browser tools — so unlike the GitHub token it is not egress-injected. Non-enterprise modes are unchanged (per-user token via the accordion). <!-- @impl: src/lib/browser-render-token.ts::applyEnterpriseBrowserToken --> <!-- @impl: src/routes/container/lifecycle.ts --> <!-- @test: src/__tests__/lib/browser-render-token.test.ts (applyEnterpriseBrowserToken) -->
4. When no Browser Rendering token is configured (any mode, or a non-advanced session), none of the browser-run surface is seeded to the agents: the `chrome-devtools` + `browser-run` MCP servers are not registered and the Pi native extension registers no tools (already gated), AND the `browser-run` / `browser-e2e` skills are stripped from both agents' skill dirs so an agent is never left with a skill for a tool it lacks. <!-- @impl: entrypoint.sh --> <!-- @test: host/__tests__/entrypoint-browser-run-mcp.test.js (entrypoint Browser Run MCP wiring > advanced but no token: strips the browser-run/browser-e2e skills from both agents) -->

**Constraints:**

- The admin token is shared across all enterprise users, so it must be scoped to `Browser Rendering - Edit` only ([REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template)); the wizard copy states this.
- The skill-strip mirrors the consult-llm skill removal in `configure_consult_llm` (the same "no provider → no skill" parity, [REQ-AGENT-031](agents.md#req-agent-031-consult-llm-key-isolation-subscription-backend-and-multi-agent-parity)).

**Priority:** P2

**Dependencies:** [REQ-BROWSER-001](#req-browser-001-browser-run-as-a-webfetch-fallback-claude-code-via-chrome-devtools-mcp), [REQ-BROWSER-002](#req-browser-002-browser-rendering-scope-in-the-cloudflare-token-template), [REQ-GITHUB-001](github.md#req-github-001-github-token-capture-and-storage), [REQ-SETUP-006](setup.md#req-setup-006-setup-streams-progress-via-ndjson)

**Verification:** [Setup storage](../../src/__tests__/routes/setup.test.ts) + [masked prefill](../../src/__tests__/routes/setup/handlers.test.ts) + [enterprise injection](../../src/__tests__/lib/browser-render-token.test.ts) + [admin UI](../../web-ui/src/__tests__/components/ConfigureStep.test.tsx) + [accordion hidden](../../web-ui/src/__tests__/components/enterprise-surface-suppression.test.tsx) + [skill strip](../../host/__tests__/entrypoint-browser-run-mcp.test.js)

**Status:** Implemented

---
