# Browser Run

In an Advanced session with Browser Rendering credentials configured, Browser Run gives the agent a real isolated Chromium session for pages that plain HTTP fetching cannot read well. It handles JavaScript-rendered content, navigation, interaction, screenshots, and structured extraction through chrome-devtools. One-shot reads retain no browser session. Interactive Claude and Pi browser state has a bounded idle lifetime set by the shipped runtime, so continue multi-step work promptly and never treat it as persistent.

Use it when a page is public and dynamic, bot-blocked, visually stateful, or blocked to ordinary fetches. General authenticated and private targets are unsupported. The narrower exception is an explicitly authorized deployed-app verification flow through the interactive browser. Do not use Browser Run for every documentation page. A simple static URL belongs on the cheaper web-fetch path.

Try it with a concrete request:

> Open the release page in Browser Run, wait for the assets table to render, and return the release tag plus asset names with the source URL.

For UI verification, ask it to open the deployed page at a named viewport, exercise one flow, and report observable state. A screenshot proves only what was rendered at that moment. It does not prove accessibility, performance, backend persistence, or another device size.

Browser Run is available only when its skill and browser tooling appear in the current Advanced session and the deployment has configured Browser Rendering credentials. Enterprise Browser Rendering tokens are injected at the boundary and never placed in the container.

Source anchors: `sdd/spec/browser-run.md` REQ-BROWSER-001/003/005/006/007/008, `preseed/agents/claude/browser-run-mcp/`, and `host/__tests__/entrypoint-browser-run-mcp.test.js`.
