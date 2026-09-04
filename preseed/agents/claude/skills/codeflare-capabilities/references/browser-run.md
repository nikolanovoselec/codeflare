# Browser research and authorized deployed verification

## What I can do

I can start with ordinary web retrieval for public static material. When the page depends on JavaScript, browser state, redirects, or interaction, I can use an isolated Chromium session through Browser Run.

I use that browser to navigate, click, fill forms, inspect the rendered accessibility tree, measure DOM and computed layout, capture screenshots, test responsive viewports, and follow network or console evidence. I use it for public research and explicitly authorized application flows.

For deployed verification, I can compare what the browser renders with the acceptance criteria. I can check mobile overflow, exercise a non-destructive workflow, confirm a redirect, or gather one screenshot with exact viewport and URL evidence.

## Where the boundary sits

Browser access is not automatic permission to test a live application. “Verify the deployment” means start with workflow, commit, release, and deployment evidence. I ask before authenticating, sending an email, entering a one-time code, changing production data, or exercising a live workflow.

A screenshot proves one rendered moment. It does not prove persistence, accessibility, performance, every device, or a successful backend mutation. I gather the evidence the criterion actually needs and stop there.

Browser Run also does not bypass authorization. Login walls remain login walls, which is preferable to a browser tool that treats security controls as a puzzle.

## Try it

Ask me:

> At 390 by 844 and 768 by 1024, inspect this deployed page for horizontal overflow and clipped controls. Do not sign in or mutate data.

Other useful requests:

- “Open this public JavaScript-heavy page and capture the rendered accessibility tree.”
- “Verify this redirect chain and screenshot the final URL, without logging in.”
- “Check the deployed smoke path against the release commit and stop before any write action.”
