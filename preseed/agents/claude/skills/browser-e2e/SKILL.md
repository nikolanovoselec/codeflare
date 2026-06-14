---
name: browser-e2e
description: "Drive your own deployed app in a real browser (Cloudflare Browser Run, via the chrome-devtools MCP server) and verify it by semantic judgment — navigate, interact, observe what actually rendered, and decide whether it meets the acceptance criteria. A judgment-based complement to scripted CI e2e: catches \"renders but looks wrong / behaves wrong\" that selector assertions miss. Activates after a deploy/preview, when verifying UI behavior against intent."
version: 1.0.0
---

# Browser e2e (Claude Code)

Verify your **own** deployed app the way a person would: open it in a real browser, interact with it, look at what actually rendered, and judge whether it satisfies the requirement — instead of asserting on brittle selectors. Backed by Cloudflare Browser Run (headless Chrome) through the **`chrome-devtools` MCP server**.

This is the **semantic** half of e2e. A scripted Playwright test in CI proves a fixed invariant (`expect(price).toBe('$9')`) and breaks when the copy changes; this proves *"does the thing actually work and look right?"* and survives wording/layout changes. Use both: deterministic invariants belong in CI; judgment ("the login flows seamlessly from the landing", "this caption is clipped mid-word on mobile", "the empty state reads wrong") belongs here.

Only available in Pro (advanced) sessions with a Cloudflare API token carrying the **Browser Rendering – Edit** scope. If you don't see `mcp__chrome-devtools__*` tools (`navigate_page`, `take_snapshot`, `take_screenshot`, `click`, `fill`, `evaluate_script`, `emulate`), browser e2e is not enabled — fall back to reasoning over the code and CI.

## Two depths — pick by what the acceptance criterion needs

- **Read-only state check** (cheap): the AC is about *rendered content/structure* (right copy, expected elements, a URL-reachable state like `?status=requested`). Use the cheap `browser-run` MCP tools — `browser_markdown` / `browser_scrape` — for a one-shot read, no live session. Don't open chrome-devtools for this.
- **Interactive flow / visual** (chrome-devtools): the AC needs *clicking through steps*, *a screenshot*, or a *specific viewport*. Use the `chrome-devtools` tools below. That's the rest of this skill.

## When to use

- **After you deploy a preview / integration build**, to confirm a change behaves and looks right before declaring it done.
- To check a **flow** (sign-in, a form, a multi-step path) end to end as a user would walk it.
- To catch **visual / responsive regressions** — overflow, clipped text, broken mobile layout — that pass every assertion but look broken.
- To verify an **acceptance criterion** that is about perceived behavior, not a fixed value.

Not a replacement for CI: keep deterministic, repeatable checks as scripted tests. This is for the judgment a fixed assertion can't make.

## Targets

- **Public / deployed URLs only.** Browser Run is remote (Cloudflare's edge), so it **cannot reach `localhost`, private IPs, or container-internal ports** — point it at the deployed preview/integration URL, not a local dev server.
- Your **own** application under test (or a target you're authorized to drive). This is not for crawling third-party sites — that's the `browser-run` fetch fallback.
- Prefer non-destructive paths. If a flow mutates state, use disposable/test data and say so.

## How to use

1. `navigate_page` to the deployed URL. For JS-heavy pages, let it settle (wait for network idle) before reading.
2. `emulate` a mobile viewport (e.g. `390x844x3,mobile,touch`) when verifying responsive behavior — check mobile first.
3. `take_snapshot` to read the rendered accessibility tree, or `evaluate_script` to pull concrete facts from the live DOM (computed styles, element counts, `scrollWidth > clientWidth` for overflow, an image's `naturalWidth` to confirm it loaded).
4. `take_screenshot` to judge anything visual — layout, spacing, clipping, on-brand feel.
5. `click` / `fill` to walk a flow, re-observing after each step.
6. **Judge against the requirement and report a verdict**: pass/fail per acceptance criterion, each backed by what you observed (a screenshot, a measured value, the rendered text) — not "the selector existed".

## Notes

- Extract just what you need (snapshot/evaluate/targeted screenshot) rather than dumping whole pages, to protect the context window.
- The verdict is the deliverable. "Looks fine" is not a verdict; "AC2 fails: on a 390px viewport the foot caption is clipped after 'corrected, an…' — screenshot attached" is.
- Findings you confirm here are real findings — fix them (or file them), don't just note them.
