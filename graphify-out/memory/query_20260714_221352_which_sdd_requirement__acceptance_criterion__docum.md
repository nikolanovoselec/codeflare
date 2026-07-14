---
type: "query"
date: "2026-07-14T22:13:52.133421+00:00"
question: "Which SDD requirement, acceptance criterion, documentation lane, and existing tests own GitHub Actions backend test execution and the workerd/Vitest crash handling in .github/workflows/test.yml and deploy workflows?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Operations", "Spec Changes"]
---

# Q: Which SDD requirement, acceptance criterion, documentation lane, and existing tests own GitHub Actions backend test execution and the workerd/Vitest crash handling in .github/workflows/test.yml and deploy workflows?

## Answer

REQ-OPS-003 AC4 owns PR-check backend/frontend test execution, while REQ-OPS-001 AC5 owns pre-deploy backend/frontend test execution. Both now anchor the shared fail-closed launcher; documentation/lanes/ci-cd.md owns the operational test and deployment behavior. The behavioral anchor is host/__tests__/backend-test-launcher.test.js.

## Outcome

- Signal: useful

## Source Nodes

- Operations
- Spec Changes