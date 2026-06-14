---
name: browser-e2e
description: "Drive your own deployed app in a real browser (Cloudflare Browser Run, via the chrome-devtools server reached through the pi-mcp-adapter `mcp` proxy) and verify it by semantic judgment — navigate, interact, emulate a mobile viewport, observe what actually rendered, and decide whether it meets the acceptance criteria. A judgment-based complement to scripted CI e2e: catches \"renders but looks wrong / behaves wrong\" that selector assertions miss. Activates after a deploy/preview, when verifying UI behavior against intent."
---

# Browser e2e (Pi)

Verify your **own** deployed app the way a person would: open it in a real browser, interact with it, look at what actually rendered, and judge whether it satisfies the requirement — instead of asserting on brittle selectors. Backed by Cloudflare Browser Run (headless Chrome) through the **`chrome-devtools`** server, which Pi reaches via the **`mcp` proxy** (the `pi-mcp-adapter`). Pi has full parity with Claude Code here — same interactive toolset.

This is the **semantic** half of e2e. A scripted test in CI proves a fixed invariant (`expect(price).toBe('$9')`) and breaks when the copy changes; this proves *"does the thing actually work and look right?"* and survives wording/layout changes. Use both: deterministic invariants belong in CI; judgment ("the login flows seamlessly from the landing", "this caption is clipped mid-word on mobile", "the empty state reads wrong") belongs here.

Only available in Pro (advanced) sessions with a Cloudflare API token carrying the **Browser Rendering – Edit** scope. If the `mcp` proxy can't reach a `chrome-devtools` server, browser e2e is not enabled — you can still do a **read-only** check with the native `browser_markdown` (judge rendered content/structure), but you cannot drive a flow; otherwise fall back to reasoning over the code and CI.

## Two depths — pick by what the acceptance criterion needs

- **Read-only state check** (cheap): the AC is about *rendered content/structure* (right copy, expected elements, a URL-reachable state like `?status=requested`). Use native `browser_markdown` / `browser_scrape` — no live session. Don't open chrome-devtools for this.
- **Interactive flow / visual** (chrome-devtools): the AC needs *clicking through steps*, *a screenshot*, or a *specific viewport*. Use the chrome-devtools tools via the proxy.

## How to use (interactive, via the `mcp` proxy)

Drive the `chrome-devtools` server's tools through the adapter `mcp` proxy (see the `pi-mcp-adapter` skill for proxy mechanics — list the server's tools, then call them):

1. `resize_page` to a mobile viewport (e.g. `390 x 844`) — or `emulate` — when verifying responsive behavior. **Check mobile first.**
2. `navigate_page` to the deployed URL. For JS-heavy pages, let it settle (wait for network idle) before reading.
3. `take_snapshot` to read the rendered accessibility tree, or `evaluate_script` to pull concrete facts from the live DOM (computed styles, element counts, `scrollWidth > clientWidth` for overflow, an image's `naturalWidth` to confirm it loaded).
4. `take_screenshot` to judge anything visual — layout, spacing, clipping, on-brand feel.
5. `click` / `fill` to walk a flow, re-observing after each step.
6. **Judge against the requirement and report a verdict**: pass/fail per acceptance criterion, each backed by what you observed (a screenshot, a measured value, the rendered text) — not "the selector existed".

Example task: *"e2e test codeflare.novoselec.ch from a mobile device viewport"* → `resize_page` to 390×844 → `navigate_page` → `take_snapshot` + `take_screenshot` → walk the sign-in / contact flow with `click`/`fill` → verdict per AC, with screenshots.

## Targets

- **Public / deployed URLs only.** Browser Run is remote (Cloudflare's edge), so it **cannot reach `localhost`, private IPs, or container-internal ports** — point it at the deployed preview/integration URL, not a local dev server.
- Your **own** application under test (or a target you're authorized to drive). This is not for crawling third-party sites — that's the `browser-run` fetch fallback.
- Prefer non-destructive paths. If a flow mutates state, use disposable/test data and say so.

## Notes

- Extract just what you need (snapshot/evaluate/targeted screenshot) rather than dumping whole pages, to protect the context window.
- The verdict is the deliverable. "Looks fine" is not a verdict; "AC2 fails: on a 390px viewport the foot caption is clipped after 'corrected, an…' — screenshot attached" is.
- Findings you confirm here are real findings — fix them (or file them), don't just note them.
