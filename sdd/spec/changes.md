# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

## 2026-07-18

- **Expired mobile sessions recover without a manual reload** ([REQ-AUTH-014](authentication.md#req-auth-014-auth-expiry-detection-mid-session), [REQ-AUTH-022](authentication.md#req-auth-022-session-expiry-on-resume-produces-a-clean-sign-in-redirect-never-a-blank-page), [REQ-MOB-009](mobile.md#req-mob-009-visibility-return-recovers-keyboard-state), [REQ-MOB-018](mobile.md#req-mob-018-decorative-webgl-canvas-retirement), [REQ-LANDING-001](landing.md#req-landing-001-mode-aware-public-landing-serving), and [REQ-LANDING-009](landing.md#req-landing-009-decorative-flare-failure-fallback); Implemented). Explicit, opaque, HTML, and Samsung-style status-zero auth failures start top-level sign-in; decorative WebGL retires on coarse-pointer backgrounding or context loss so the stable dark CSS surface remains visible.

- **Pi starts with compact canonical context and discovers specialized capabilities on demand** ([REQ-AGENT-007](agents.md#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-065](agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents), [REQ-AGENT-095](agents.md#req-agent-095-compact-pi-skill-catalog), [REQ-AGENT-096](agents.md#req-agent-096-on-demand-pi-tool-activation), and [REQ-AGENT-097](agents.md#req-agent-097-bounded-pi-startup-context); Implemented). Canonical path rules become grouped Pi skills, proactive skills stay visible with compact trigger-preserving descriptions, one capability tool activates registered tools, event owners activate delegation before unchanged review and extraction follow-ups, and independent managed-seed and complete-runtime budgets bound startup context.

- **Pi starts with context-mode disabled pending an upstream memory-safe adapter** ([REQ-AGENT-076](agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) and [REQ-AGENT-089](agents.md#req-agent-089-pi-context-mode-foreground-ownership); Implemented). Fresh containers preserve the package for explicit `/ctx on` but disable its skills and adapter by default; every workflow retains its native fallback.

- **Per-AC test evidence now supports one or more named anchors** ([REQ-AGENT-094](agents.md#req-agent-094-per-ac-test-evidence-supports-multiple-anchors); Implemented). Every non-manual AC still requires resolving behavioral evidence, while multiple independently validated blocks or files may jointly verify one behavior.

- **Agent workflow traceability now separates graph reminders and Import Mode transition rules** ([REQ-AGENT-091](agents.md#req-agent-091-advanced-session-graph-first-runtime-reminders), [REQ-AGENT-092](agents.md#req-agent-092-import-transition-review-suppression), and [REQ-AGENT-093](agents.md#req-agent-093-import-mode-tdd-status-assignment); Implemented). Existing graph-first startup and soft-nudge behavior, transition-time review suppression, and TDD-aware imported-requirement status assignment now have dedicated requirements; runtime behavior is unchanged.

## 2026-07-17

- **“Agentic engineering engine” branding now appears consistently across current product surfaces** ([REQ-LANDING-003](landing.md#req-landing-003-landing-social-share-and-search-metadata), [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page), and [REQ-AUTH-012](authentication.md#req-auth-012-welcome-email-on-first-login); Implemented). The SPA metadata, install manifest, login and onboarding surfaces, subscription and usage views, welcome email, documentation, and seeded tutorial use the current phrase while historical changelog wording remains archived.

- **Public login pages remain crawlable but stay out of search results** ([REQ-LANDING-008](landing.md#req-landing-008-login-crawler-exclusion-controls) and [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page); Implemented). The sitemap omits login, login responses carry `noindex, nofollow`, and `robots.txt` leaves the route crawlable so search engines can observe that directive.

- **Enterprise route reasoning exposes every supported Pi thinking level** ([REQ-ENTERPRISE-012](enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list) and [REQ-ENTERPRISE-013](enterprise-mode.md#req-enterprise-013-per-group-dynamic-routing); Implemented). Default-route and per-group selectors accept the full supported range and reject unknown levels.

- **The Enter-the-Matrix call-to-action contains every decode frame** ([REQ-LANDING-006](landing.md#req-landing-006-enter-the-matrix-sign-in-cta); Implemented). Its border keeps expanding with wide churn glyphs inside an isolated slot, so Velocity, Quality, Security, Control, and Cost remain stationary.

- **Pi extension dependency updates open independently** ([REQ-OPS-020](operations.md#req-ops-020-shadow-pin-version-bump-automation); Implemented). Automatic discovery feeds one non-fail-fast update job and pull request per extension, so one failed bump no longer blocks unrelated extensions.
