# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

## 2026-07-18

- **Pi starts with compact canonical context and discovers specialized capabilities on demand** ([REQ-AGENT-007](agents.md#req-agent-007-multi-agent-adaptation-pipeline), [REQ-AGENT-065](agents.md#req-agent-065-engineering-constitution-preseeded-to-all-agents), and [REQ-AGENT-095](agents.md#req-agent-095-compact-pi-context-and-on-demand-capabilities); Implemented). Canonical path rules become grouped Pi skills, proactive skills stay visible, one capability tool activates registered tools, and event owners activate delegation before unchanged review and extraction follow-ups.

- **Pi starts with context-mode disabled pending an upstream memory-safe adapter** ([REQ-AGENT-076](agents.md#req-agent-076-pi-context-mode-enablement-and-tool-extension-defaults) and [REQ-AGENT-089](agents.md#req-agent-089-pi-context-mode-foreground-ownership); Implemented). Fresh containers preserve the package for explicit `/ctx on` but disable its skills and adapter by default; every workflow retains its native fallback.

- **Per-AC test evidence now supports one or more named anchors** ([REQ-AGENT-094](agents.md#req-agent-094-per-ac-test-evidence-supports-multiple-anchors); Implemented). Every non-manual AC still requires resolving behavioral evidence, while multiple independently validated blocks or files may jointly verify one behavior.

## 2026-07-17

- **“Agentic engineering engine” branding now appears consistently across current product surfaces** ([REQ-LANDING-003](landing.md#req-landing-003-landing-social-share-and-search-metadata), [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page), and [REQ-AUTH-012](authentication.md#req-auth-012-welcome-email-on-first-login); Implemented). The SPA metadata, install manifest, login and onboarding surfaces, subscription and usage views, welcome email, documentation, and seeded tutorial use the current phrase while historical changelog wording remains archived.

- **Public login pages remain crawlable but stay out of search results** ([REQ-LANDING-008](landing.md#req-landing-008-login-crawler-exclusion-controls) and [REQ-SETUP-010](setup.md#req-setup-010-social-share-preview-metadata-on-the-public-landing-page); Implemented). The sitemap omits login, login responses carry `noindex, nofollow`, and `robots.txt` leaves the route crawlable so search engines can observe that directive.

- **Enterprise route reasoning exposes every supported Pi thinking level** ([REQ-ENTERPRISE-012](enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list) and [REQ-ENTERPRISE-013](enterprise-mode.md#req-enterprise-013-per-group-dynamic-routing); Implemented). Default-route and per-group selectors accept the full supported range and reject unknown levels.

- **The Enter-the-Matrix call-to-action contains every decode frame** ([REQ-LANDING-006](landing.md#req-landing-006-enter-the-matrix-sign-in-cta); Implemented). Its border grows with wide churn glyphs while the resting label remains the minimum width, preventing clipping or paint outside the control.

- **Pi extension dependency updates open independently** ([REQ-OPS-020](operations.md#req-ops-020-shadow-pin-version-bump-automation); Implemented). Automatic discovery feeds one non-fail-fast update job and pull request per extension, so one failed bump no longer blocks unrelated extensions.
