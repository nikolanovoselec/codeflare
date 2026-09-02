# Browser Run and deployed UI verification

**Availability:** Advanced session with Browser Run tooling visible and Browser Rendering credentials configured. General private or authenticated targets remain unsupported, apart from explicitly authorized deployed-app verification flows through the interactive browser.

## What I can do

I can fetch a static public page through the ordinary web path first. When that fails because the page depends on JavaScript, interaction, rendering state, or a browser gate, I can open isolated Chromium. I can navigate, wait for rendered state, interact with controls, extract clean content, capture screenshots, and exercise a deployed flow at named desktop, tablet, or mobile viewports.

One-shot reads retain no browser session. Interactive Claude and Pi browser state has a bounded idle lifetime. I continue multi-step work promptly and never treat browser state as durable context.

## Why the boundary matters

Browser evidence is specific. A screenshot proves what one viewport rendered at one moment. It does not prove backend persistence, accessibility, performance, another device size, or that a later deployment kept the same behavior. Deterministic assertions remain in CI. Deployed acceptance adds the live evidence CI cannot supply.

Enterprise Browser Rendering tokens stay at the interception boundary instead of entering the container.

## Try it

Ask me:

> Open this deployed page at 390 by 844, complete the named flow, capture the relevant states, and compare the observable result with these acceptance criteria.

For research, ask me to open a JavaScript-rendered release page and return the rendered tag and asset names with the source URL.

Source anchors: `sdd/spec/browser-run.md` REQ-BROWSER-001/003/005/006/007/008, `preseed/agents/claude/browser-run-mcp/`, and `host/__tests__/entrypoint-browser-run-mcp.test.js`.
