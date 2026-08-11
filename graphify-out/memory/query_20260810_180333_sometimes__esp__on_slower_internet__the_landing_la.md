---
type: "query"
date: "2026-08-10T18:03:33.862716+00:00"
question: "sometimes (esp. on slower internet) the landing lage codeflare.ch loads and then a second afterwards everything jumps and styling (font, colors) load. page should not fucking show until text and CSS/design has loaded. lazy load is OK, but it is not allowed to show content that is not styled in the final design!!!!"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Landing", "Tests"]
---

# Q: sometimes (esp. on slower internet) the landing lage codeflare.ch loads and then a second afterwards everything jumps and styling (font, colors) load. page should not fucking show until text and CSS/design has loaded. lazy load is OK, but it is not allowed to show content that is not styled in the final design!!!!

## Answer

The public landing is implemented by landing/src/pages/index.astro through landing/src/layouts/BaseLayout.astro, with final design tokens and styles in landing/src/styles/tokens.css and global.css and Worker serving/security headers in src/index.ts. Slow-3G browser measurement confirmed the stylesheet is render-blocking, but font-display: swap allows fallback text to paint before the preloaded Inter and JetBrains Mono fonts finish. The fix gates body visibility over the existing dark canvas until the Astro stylesheet and both critical fonts resolve, while keeping server-rendered content visible when JavaScript is disabled; the inline gate is authorized by an integrity-pinned CSP hash.

## Outcome

- Signal: useful

## Source Nodes

- Landing
- Tests