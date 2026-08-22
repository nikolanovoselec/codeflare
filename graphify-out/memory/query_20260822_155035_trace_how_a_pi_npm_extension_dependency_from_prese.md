---
type: "query"
date: "2026-08-22T15:50:35.387760+00:00"
question: "Trace how a Pi npm extension dependency from preseed/agents/pi/package.json is installed into the container, enabled in settings.json, included in the generated seed, mirrored to ~/.pi, and warmed into the Jiti cache. Name exact files and tests."
contributor: "graphify"
outcome: "useful"
source_nodes: ["npm-tools/package.json", "WARMED_NPM_ENTRYPOINTS", "resolveJitiCachePath"]
---

# Q: Trace how a Pi npm extension dependency from preseed/agents/pi/package.json is installed into the container, enabled in settings.json, included in the generated seed, mirrored to ~/.pi, and warmed into the Jiti cache. Name exact files and tests.

## Answer

The managed Pi package is exact-pinned in preseed/agents/pi/package.json and its lock, installed into the image-local npm tree by Dockerfile, merged into ~/.pi/agent/settings.json by entrypoint.sh, and embedded through scripts/agent-seed-core.mjs into src/lib/agent-seed.generated.ts. Dockerfile explicitly warms selected npm entrypoints through scripts/verify-pi-lockstep.mjs and fails closed if their path-correct JITI artifacts are missing. host/__tests__/pi-settings-packages.test.js covers lock-backed required-package assembly, while host/__tests__/pi-lockstep.test.js covers Dockerfile entrypoint declaration, warming, and re-verification.

## Outcome

- Signal: useful

## Source Nodes

- npm-tools/package.json
- WARMED_NPM_ENTRYPOINTS
- resolveJitiCachePath