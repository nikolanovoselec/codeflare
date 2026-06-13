---
name: browser-e2e
description: Verify your own deployed app by semantic judgment of its rendered state, using the Pi-native Browser Run tools (browser_markdown / browser_content / browser_scrape). Fetch the real, JS-executed page and judge whether it meets the acceptance criteria — a judgment-based complement to scripted CI e2e that catches "renders but wrong" which selector assertions miss. Activates after a deploy/preview, when verifying a deployed page against intent.
---

# Browser e2e (Pi)

Verify your **own** deployed app by judgment, not brittle selectors: fetch the real, JavaScript-executed page through Cloudflare Browser Run and decide whether what rendered satisfies the requirement. Exposed as **native Pi tools** (`browser_markdown`, `browser_content`, `browser_scrape`) — no MCP.

This is the **semantic** half of e2e. A scripted test in CI proves a fixed invariant and breaks when the copy changes; this proves *"did the page actually render the right thing?"* and survives wording/layout changes. Use both: deterministic invariants belong in CI; judgment belongs here.

Only available in Pro (advanced) sessions with a Cloudflare API token carrying the **Browser Rendering – Edit** scope. If the `browser_*` tools are not present, browser e2e is not enabled — fall back to reasoning over the code and CI.

## What Pi can and cannot do here

- **Can:** fetch the fully-rendered state of a deployed page (after JS runs) and judge its content/structure against the acceptance criteria. `browser_markdown` for the readable result, `browser_content` for the rendered HTML/DOM, `browser_scrape` for specific elements by CSS selector.
- **Cannot:** click, type, or walk a multi-step flow — the Pi tools are **one-shot fetches**, not an interactive session. (Claude Code's `browser-e2e` skill, via chrome-devtools, drives interactive flows.) To check a post-action state with Pi, navigate directly to the resulting URL (e.g. `/login?status=requested`) and judge what renders.

## When to use

- **After you deploy a preview / integration build**, to confirm a page renders the right content and structure before declaring it done.
- To verify an **acceptance criterion** about rendered output (the right copy, the expected elements present, an error/empty state showing correctly) where a fixed assertion would be brittle.
- To check a state reachable by URL (query-param states, deep links) without a scripted harness.

Not a replacement for CI: keep deterministic, repeatable checks as scripted tests. This is for the judgment a fixed assertion can't make.

## Targets

- **Public / deployed URLs only.** Browser Run is remote, so it **cannot reach `localhost`, private IPs, or container-internal ports** — point it at the deployed preview/integration URL, not a local dev server.
- Your **own** application under test (or a target you're authorized to drive). Crawling third-party sites is the `browser-run` fetch fallback, not this.

## How to use

1. `browser_markdown` (or `browser_content` for DOM structure) on the deployed URL, with `wait_until: "networkidle0"` for JS-heavy pages so content has rendered.
2. `browser_scrape` with CSS selectors to pull the specific elements an acceptance criterion is about (headings, a form's fields, an error banner).
3. **Judge against the requirement and report a verdict**: pass/fail per acceptance criterion, each backed by what you observed in the rendered output — not "the selector existed".

## Notes

- Keep requests narrow (markdown over full HTML, scoped selectors) to protect the context window.
- The verdict is the deliverable. "Looks fine" is not a verdict; cite the rendered text or element you checked.
- Findings you confirm here are real findings — fix them (or file them), don't just note them.
