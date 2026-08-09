---
type: "query"
date: "2026-08-09T23:02:25.721609+00:00"
question: "Wave 9 behavioral test quality: identify reusable behavioral test patterns and production ownership for shell, Dashboard, SplashCursor, download-policy, and coverage gates"
contributor: "graphify"
outcome: "useful"
source_nodes: ["entrypoint-rclone-filters.test.js", "request-router.ts", "Dashboard", "SplashCursor", "downloads-policy.ts", "REQ-OPS-022"]
---

# Q: Wave 9 behavioral test quality: identify reusable behavioral test patterns and production ownership for shell, Dashboard, SplashCursor, download-policy, and coverage gates

## Answer

Reusable ownership is split across entrypoint.sh behavior harnesses, the importable request router, Dashboard rendering, the SplashCursor wrapper calling createSplashSimulation, downloads-policy consumed by storage download and user profile routes, and the shared coverage action/checker. Existing graph nodes identify entrypoint-rclone-filters as the behavioral rclone pattern, request-router as the HTTP seam, Dashboard as the rendered state owner, SplashCursor as the lifecycle wrapper, downloads-policy as the shared fail-open resolver, and REQ-OPS-022 as coverage governance.

## Outcome

- Signal: useful

## Source Nodes

- entrypoint-rclone-filters.test.js
- request-router.ts
- Dashboard
- SplashCursor
- downloads-policy.ts
- REQ-OPS-022