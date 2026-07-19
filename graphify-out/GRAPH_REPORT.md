# Graph Report - /home/user/workspace/codeflare  (2026-07-18)

## Corpus Check
- label apply mode — file stats not available

## Summary
- 495 nodes · 1597 edges · 27 communities (21 shown, 6 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `bfcc14ae`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Worker Backend Runtime
- Marketing Landing Experience
- Claude Impeccable Live Editing
- Pi Impeccable Live Editing
- Session Workspace Management
- Dashboard Storage Interface
- Claude UI Antipattern Detector
- Pi UI Antipattern Detector
- Web App Authentication
- Pi Agent Orchestration Extensions
- GitHub Provider Integration
- Mobile Terminal Interaction
- Terminal Layout and Vault
- Setup Configuration Interface
- Container Host Runtime
- Pi Todo Session State
- Landing WebGL Flare
- Claude Turnstile Worker Template
- Pi Impeccable Hook Integration
- Web App Splash Rendering
- Claude Impeccable Hook Integration
- Claude Browser Run MCP
- Claude Live Browser DOM
- Pi Browser Run Extension
- Pi Command Extension
- Pi Live Browser DOM
- Agent Seed Materialization

## God Nodes (most connected - your core abstractions)
1. `src/types.ts` - 78 edges
2. `src/lib/error-types.ts` - 66 edges
3. `src/lib/logger.ts` - 64 edges
4. `src/lib/kv-keys.ts` - 52 edges
5. `src/index.ts` - 45 edges
6. `web-ui/src/components/Icon.tsx` - 43 edges
7. `src/lib/subscription.ts` - 37 edges
8. `web-ui/src/types.ts` - 36 edges
9. `src/middleware/auth.ts` - 34 edges
10. `web-ui/src/stores/session.ts` - 34 edges

## Surprising Connections (you probably didn't know these)
- `landing/src/layouts/BaseLayout.astro` --depends_on--> `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url`  [EXTRACTED]
  landing/src/layouts/BaseLayout.astro → @fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url
- `landing/src/layouts/BaseLayout.astro` --depends_on--> `@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url`  [EXTRACTED]
  landing/src/layouts/BaseLayout.astro → @fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url
- `preseed/agents/pi/npm/rpiv-todo-session-isolation/state/store.ts` --depends_on--> `web-ui/src/lib/vault-cache.ts`  [EXTRACTED]
  preseed/agents/pi/npm/rpiv-todo-session-isolation/state/store.ts → web-ui/src/lib/vault-cache.ts
- `host/src/session.ts` --depends_on--> `web-ui/src/components/FloatingTerminalButtons.tsx`  [EXTRACTED]
  host/src/session.ts → web-ui/src/components/FloatingTerminalButtons.tsx
- `host/src/session.ts` --depends_on--> `web-ui/src/components/Layout.tsx`  [EXTRACTED]
  host/src/session.ts → web-ui/src/components/Layout.tsx

## Import Cycles
- None detected.

## Communities (27 total, 6 thin omitted)

### Community 0 - "Worker Backend Runtime"
Cohesion: 0.10
Nodes (121): src/cloudflare-browser-interceptor.ts, src/container/container-config.ts, src/container/container-env.ts, src/container/container-lifecycle.ts, src/container/container-metrics.ts, src/container/container-router.ts, src/container/index.ts, src/egress-controller.ts (+113 more)

### Community 1 - "Marketing Landing Experience"
Cohesion: 0.07
Nodes (52): @fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url, @fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url, landing/src/components/CodeEditor.astro, landing/src/components/ContactForm.astro, landing/src/components/FeatureCard.astro, landing/src/components/FeatureGrid.astro, landing/src/components/FeatureTerminals.astro, landing/src/components/Footer.astro (+44 more)

### Community 2 - "Claude Impeccable Live Editing"
Cohesion: 0.11
Nodes (32): preseed/agents/claude/skills/impeccable/scripts/context-signals.mjs, preseed/agents/claude/skills/impeccable/scripts/context.mjs, preseed/agents/claude/skills/impeccable/scripts/critique-storage.mjs, preseed/agents/claude/skills/impeccable/scripts/lib/design-parser.mjs, preseed/agents/claude/skills/impeccable/scripts/lib/impeccable-paths.mjs, preseed/agents/claude/skills/impeccable/scripts/lib/target-args.mjs, preseed/agents/claude/skills/impeccable/scripts/live-accept.mjs, preseed/agents/claude/skills/impeccable/scripts/live-commit-manual-edits.mjs (+24 more)

### Community 3 - "Pi Impeccable Live Editing"
Cohesion: 0.11
Nodes (32): preseed/agents/pi/skills/impeccable/scripts/context-signals.mjs, preseed/agents/pi/skills/impeccable/scripts/context.mjs, preseed/agents/pi/skills/impeccable/scripts/critique-storage.mjs, preseed/agents/pi/skills/impeccable/scripts/lib/design-parser.mjs, preseed/agents/pi/skills/impeccable/scripts/lib/impeccable-paths.mjs, preseed/agents/pi/skills/impeccable/scripts/lib/target-args.mjs, preseed/agents/pi/skills/impeccable/scripts/live-accept.mjs, preseed/agents/pi/skills/impeccable/scripts/live-commit-manual-edits.mjs (+24 more)

### Community 4 - "Session Workspace Management"
Cohesion: 0.16
Nodes (28): web-ui/src/components/CreateSessionDialog.tsx, web-ui/src/components/InitProgress.tsx, web-ui/src/components/SelectableSessionCard.tsx, web-ui/src/components/SessionDropdown.tsx, web-ui/src/components/SessionStatCard.tsx, web-ui/src/components/SessionSwitcher.tsx, web-ui/src/components/TerminalArea.tsx, web-ui/src/components/TerminalGrid.tsx (+20 more)

### Community 5 - "Dashboard Storage Interface"
Cohesion: 0.13
Nodes (28): web-ui/src/components/Dashboard.tsx, web-ui/src/components/DownloadsDisabledPopup.tsx, web-ui/src/components/FilePreview.tsx, web-ui/src/components/Icon.tsx, web-ui/src/components/MultiViewActionRow.tsx, web-ui/src/components/SessionContextMenu.tsx, web-ui/src/components/SessionLimitPopup.tsx, web-ui/src/components/StatCards.tsx (+20 more)

### Community 6 - "Claude UI Antipattern Detector"
Cohesion: 0.22
Nodes (24): preseed/agents/claude/skills/impeccable/scripts/detect-csp.mjs, preseed/agents/claude/skills/impeccable/scripts/detector/browser/injected/index.mjs, preseed/agents/claude/skills/impeccable/scripts/detector/cli/main.mjs, preseed/agents/claude/skills/impeccable/scripts/detector/design-system.mjs, preseed/agents/claude/skills/impeccable/scripts/detector/detect-antipatterns-browser.js, preseed/agents/claude/skills/impeccable/scripts/detector/detect-antipatterns.mjs, preseed/agents/claude/skills/impeccable/scripts/detector/engines/browser/detect-url.mjs, preseed/agents/claude/skills/impeccable/scripts/detector/engines/regex/detect-text.mjs (+16 more)

### Community 7 - "Pi UI Antipattern Detector"
Cohesion: 0.22
Nodes (24): preseed/agents/pi/skills/impeccable/scripts/detect-csp.mjs, preseed/agents/pi/skills/impeccable/scripts/detector/browser/injected/index.mjs, preseed/agents/pi/skills/impeccable/scripts/detector/cli/main.mjs, preseed/agents/pi/skills/impeccable/scripts/detector/design-system.mjs, preseed/agents/pi/skills/impeccable/scripts/detector/detect-antipatterns-browser.js, preseed/agents/pi/skills/impeccable/scripts/detector/detect-antipatterns.mjs, preseed/agents/pi/skills/impeccable/scripts/detector/engines/browser/detect-url.mjs, preseed/agents/pi/skills/impeccable/scripts/detector/engines/regex/detect-text.mjs (+16 more)

### Community 8 - "Web App Authentication"
Cohesion: 0.16
Nodes (22): src/lib/schemas.ts, web-ui/src/App.tsx, web-ui/src/api/client.ts, web-ui/src/api/fetch-helper.ts, web-ui/src/api/storage.ts, web-ui/src/components/KittScanner.tsx, web-ui/src/components/LoginPage.tsx, web-ui/src/components/OnboardingLanding.tsx (+14 more)

### Community 9 - "Pi Agent Orchestration Extensions"
Cohesion: 0.18
Nodes (17): preseed/agents/pi/extensions/active-repo-memory.ts, preseed/agents/pi/extensions/capability-helpers.ts, preseed/agents/pi/extensions/capability.ts, preseed/agents/pi/extensions/codeflare-pi.ts, preseed/agents/pi/extensions/context-mode-runtime.ts, preseed/agents/pi/extensions/graphify-helpers.ts, preseed/agents/pi/extensions/graphify-native.ts, preseed/agents/pi/extensions/guard-helpers.ts (+9 more)

### Community 10 - "GitHub Provider Integration"
Cohesion: 0.21
Nodes (17): web-ui/src/api/cloudflare.ts, web-ui/src/api/github.ts, web-ui/src/components/connect/OAuthConnectCard.tsx, web-ui/src/components/connect/TierChooserDialog.tsx, web-ui/src/components/github/ClonePicker.tsx, web-ui/src/components/github/ConnectCard.tsx, web-ui/src/components/github/ConnectedHeader.tsx, web-ui/src/components/github/GitHubPanel.tsx (+9 more)

### Community 11 - "Mobile Terminal Interaction"
Cohesion: 0.30
Nodes (15): web-ui/src/components/FloatingTerminalButtons.tsx, web-ui/src/components/SettingsPanel.tsx, web-ui/src/components/Terminal.tsx, web-ui/src/components/settings/AppearanceSection.tsx, web-ui/src/components/settings/SessionSection.tsx, web-ui/src/hooks/useScrollCorrection.ts, web-ui/src/hooks/useTerminal.ts, web-ui/src/lib/mobile.ts (+7 more)

### Community 12 - "Terminal Layout and Vault"
Cohesion: 0.22
Nodes (14): web-ui/src/components/Header.tsx, web-ui/src/components/Layout.tsx, web-ui/src/components/VaultButton.tsx, web-ui/src/lib/browser-storage-persistence.ts, web-ui/src/lib/constants.ts, web-ui/src/lib/gravatar.ts, web-ui/src/lib/md5.ts, web-ui/src/lib/vault-local-readiness.ts (+6 more)

### Community 13 - "Setup Configuration Interface"
Cohesion: 0.25
Nodes (14): web-ui/src/components/setup/CloudflareProviderChooser.tsx, web-ui/src/components/setup/ConfigureStep.tsx, web-ui/src/components/setup/GitHubProviderChooser.tsx, web-ui/src/components/setup/PerGroupRoutingCard.tsx, web-ui/src/components/setup/ProgressStep.tsx, web-ui/src/components/setup/SetupSection.tsx, web-ui/src/components/setup/WelcomeStep.tsx, web-ui/src/components/ui/Button.tsx (+6 more)

### Community 14 - "Container Host Runtime"
Cohesion: 0.26
Nodes (12): host/src/activity-tracker.ts, host/src/auth-check.ts, host/src/final-sync.ts, host/src/git-clone.ts, host/src/metrics.ts, host/src/prewarm-config.ts, host/src/server.ts, host/src/session-manager.ts (+4 more)

### Community 15 - "Pi Todo Session State"
Cohesion: 0.57
Nodes (7): preseed/agents/pi/npm/rpiv-todo-session-isolation/index.ts, preseed/agents/pi/npm/rpiv-todo-session-isolation/state/lifecycle.ts, preseed/agents/pi/npm/rpiv-todo-session-isolation/state/state.ts, preseed/agents/pi/npm/rpiv-todo-session-isolation/state/store.ts, preseed/agents/pi/npm/rpiv-todo-session-isolation/todo-overlay.ts, preseed/agents/pi/npm/rpiv-todo-session-isolation/todo.ts, preseed/agents/pi/npm/rpiv-todo-session-isolation/tool/types.ts

### Community 16 - "Landing WebGL Flare"
Cohesion: 0.50
Nodes (5): landing/src/lib/splash-cursor-logic.ts, landing/src/lib/splash-math.ts, landing/src/lib/splash-shaders.ts, landing/src/lib/webgl-utils.ts, landing/src/scripts/splash.ts

### Community 17 - "Claude Turnstile Worker Template"
Cohesion: 0.80
Nodes (5): preseed/agents/claude/skills/turnstile-spin/templates/worker/src/errors.ts, preseed/agents/claude/skills/turnstile-spin/templates/worker/src/index.ts, preseed/agents/claude/skills/turnstile-spin/templates/worker/src/observability.ts, preseed/agents/claude/skills/turnstile-spin/templates/worker/src/types.ts, preseed/agents/claude/skills/turnstile-spin/templates/worker/src/validate.ts

### Community 18 - "Pi Impeccable Hook Integration"
Cohesion: 0.40
Nodes (5): preseed/agents/pi/npm/rpiv-todo-session-isolation/install.mjs, preseed/agents/pi/skills/impeccable/scripts/hook-admin.mjs, preseed/agents/pi/skills/impeccable/scripts/hook-before-edit.mjs, preseed/agents/pi/skills/impeccable/scripts/hook-lib.mjs, preseed/agents/pi/skills/impeccable/scripts/hook.mjs

### Community 19 - "Web App Splash Rendering"
Cohesion: 0.50
Nodes (5): web-ui/src/components/SplashCursor.tsx, web-ui/src/lib/splash-cursor-logic.ts, web-ui/src/lib/splash-math.ts, web-ui/src/lib/splash-shaders.ts, web-ui/src/lib/webgl-utils.ts

### Community 20 - "Claude Impeccable Hook Integration"
Cohesion: 0.50
Nodes (4): preseed/agents/claude/skills/impeccable/scripts/hook-admin.mjs, preseed/agents/claude/skills/impeccable/scripts/hook-before-edit.mjs, preseed/agents/claude/skills/impeccable/scripts/hook-lib.mjs, preseed/agents/claude/skills/impeccable/scripts/hook.mjs

## Knowledge Gaps
- **77 isolated node(s):** `host/src/auth-check.ts`, `host/src/final-sync.ts`, `host/src/git-clone.ts`, `host/src/vault-proxy.ts`, `host/src/vscode-proxy.ts` (+72 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `src/lib/logger.ts` connect `Worker Backend Runtime` to `Claude Impeccable Live Editing`, `Pi Impeccable Live Editing`, `Session Workspace Management`, `Claude UI Antipattern Detector`, `Pi UI Antipattern Detector`, `Pi Todo Session State`?**
  _High betweenness centrality (0.508) - this node is a cross-community bridge._
- **Why does `web-ui/src/stores/session.ts` connect `Session Workspace Management` to `Worker Backend Runtime`, `Dashboard Storage Interface`, `Web App Authentication`, `GitHub Provider Integration`, `Mobile Terminal Interaction`, `Terminal Layout and Vault`?**
  _High betweenness centrality (0.275) - this node is a cross-community bridge._
- **Why does `landing/src/content/site.ts` connect `Marketing Landing Experience` to `Worker Backend Runtime`, `Mobile Terminal Interaction`, `Terminal Layout and Vault`?**
  _High betweenness centrality (0.163) - this node is a cross-community bridge._
- **What connects `host/src/auth-check.ts`, `host/src/final-sync.ts`, `host/src/git-clone.ts` to the rest of the system?**
  _77 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Worker Backend Runtime` be split into smaller, more focused modules?**
  _Cohesion score 0.09779614325068871 - nodes in this community are weakly interconnected._
- **Should `Marketing Landing Experience` be split into smaller, more focused modules?**
  _Cohesion score 0.07315233785822021 - nodes in this community are weakly interconnected._
- **Should `Claude Impeccable Live Editing` be split into smaller, more focused modules?**
  _Cohesion score 0.10887096774193548 - nodes in this community are weakly interconnected._