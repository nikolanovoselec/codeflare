---
name: browser-e2e
description: Verify a deployed UI in a browser for interaction, mobile layout, and visuals.
---

# Browser e2e (Pi)

Verify your **own** deployed app the way a person would: open it in a real browser, interact with it, look at what actually rendered, and judge whether it satisfies the requirement — instead of asserting on brittle selectors. Backed by Cloudflare Browser Run (headless Chrome) through the **`chrome-devtools`** server, which Pi reaches via **pi-mcp-adapter direct tools**. Pi has full parity with Claude Code here — same interactive toolset.

This is the **semantic** half of e2e. A scripted test in CI proves a fixed invariant (`expect(price).toBe('$9')`) and breaks when the copy changes; this proves *"does the thing actually work and look right?"* and survives wording/layout changes. Use both: deterministic invariants belong in CI; judgment ("the login flows seamlessly from the landing", "this caption is clipped mid-word on mobile", "the empty state reads wrong") belongs here.

Interactive testing requires an Advanced session with Cloudflare Browser Run configured and **Browser Rendering – Edit** access. If the interactive preflight cannot establish a usable browser, report the blocked check. A read-only `browser_markdown` check is not interactive acceptance.

## Two depths — pick by what the acceptance criterion needs

- **Read-only state check** (cheap): the AC is about *rendered content/structure* (right copy, expected elements, a URL-reachable state like `?status=requested`). Use native `browser_markdown` / `browser_scrape` — no live session. Don't open chrome-devtools for this.
- **Interactive flow / visual** (chrome-devtools): the AC needs *clicking through steps*, *a screenshot*, or a *specific viewport*. Use the chrome-devtools tools via activated direct tools.

## How to use (interactive direct tools)

**Required first:** read `browser-run/SKILL.md` from the sibling skill directory and follow its **Interactive preflight and recovery** before resizing, navigating, or signing in. Use the live page ID and keep the same tab through login and testing. For a protected Codeflare test, verify the expected disposable identity and bucket before making changes.

1. `resize_page` to a mobile viewport (e.g. `390 x 844`) — or `emulate` — when verifying responsive behavior. **Check mobile first.**
2. `navigate_page` to the deployed URL with an explicit 120000 ms timeout supported by the live schema. For JS-heavy pages, let it settle (wait for network idle) before reading.
3. `take_snapshot` to read the rendered accessibility tree, or `evaluate_script` to pull concrete facts from the live DOM (computed styles, element counts, `scrollWidth > clientWidth` for overflow, an image's `naturalWidth` to confirm it loaded).
4. `take_screenshot` to judge anything visual — layout, spacing, clipping, on-brand feel.
5. `click` / `fill` to walk a flow, re-observing after each step.
6. **Judge against the requirement and report a verdict**: pass/fail per acceptance criterion, each backed by what you observed (a screenshot, a measured value, the rendered text) — not "the selector existed".

Example task: *"e2e test the integration deployment from a mobile device viewport"* → `resize_page` to 390×844 → `navigate_page` → `take_snapshot` + `take_screenshot` → walk the sign-in / contact flow with `click`/`fill` → verdict per AC, with screenshots.

## Targets

- **Public / deployed URLs only.** Browser Run is remote (Cloudflare's edge), so it **cannot reach `localhost`, private IPs, or container-internal ports** — point it at the deployed preview/integration URL, not a local dev server.
- Your **own** application under test (or a target you're authorized to drive). This is not for crawling third-party sites — that's the `browser-run` fetch fallback.
- Prefer non-destructive paths. If a flow mutates state, use disposable/test data and say so.
- For a Codeflare terminal check, wait for **Ready**, click **Open** on the startup overlay, and focus the terminal input. Submit with `chrome-devtools_type_text` and `submitKey: "Enter"`. Wait for the expected tool result before Stop or Delete; a prompt visible on screen is not proof it ran.

## Notes

- Extract just what you need (snapshot/evaluate/targeted screenshot) rather than dumping whole pages, to protect the context window.
- The verdict is the deliverable. "Looks fine" is not a verdict; "AC2 fails: on a 390px viewport the foot caption is clipped after 'corrected, an…' — screenshot attached" is.
- Findings you confirm here are real findings — fix them (or file them), don't just note them.
