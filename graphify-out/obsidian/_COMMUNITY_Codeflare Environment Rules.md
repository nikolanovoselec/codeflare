---
type: community
cohesion: 0.05
members: 42
---

# Codeflare Environment Rules

**Cohesion:** 0.05 - loosely connected
**Members:** 42 nodes

## Members
- [[1-CPU Container Constraint]] - document - preseed/agents/claude/rules/cloudflare-environment.md
- [[App Transport Security (ATS)]] - document - preseed/agents/claude/rules/swift/security.md
- [[Avoided Stack (Python, Go, Docker, Postgres, MySQL, Node-only APIs)]] - document - preseed/agents/claude/rules/cloudflare-environment.md
- [[Cloudflare Default Stack (Hono, SolidJS, D1, KV, R2, Durable Objects)]] - document - preseed/agents/claude/rules/cloudflare-environment.md
- [[Cloudflare Workers as Default Deploy Target]] - document - preseed/agents/claude/rules/cloudflare-environment.md
- [[Codeflare Environment Rules]] - document - preseed/agents/claude/rules/cloudflare-environment.md
- [[Commit Message Format (type description)]] - document - preseed/agents/claude/rules/git-workflow.md
- [[Common Security Guidelines]] - document - preseed/agents/claude/rules/common/security.md
- [[Forbidden Local Commands (vitest, build, dev, tsc, lint)]] - document - preseed/agents/claude/rules/no-local-builds.md
- [[GH_TOKEN  CLOUDFLARE_API_TOKEN  CLOUDFLARE_ACCOUNT_ID Env Vars]] - document - preseed/agents/claude/rules/git-workflow.md
- [[Git Workflow (Core)]] - document - preseed/agents/claude/rules/git-workflow.md
- [[Go Race Detection in CI]] - document - preseed/agents/claude/rules/golang/testing.md
- [[Go Security Rules]] - document - preseed/agents/claude/rules/golang/security.md
- [[Go Testing (go test, table-driven)]] - document - preseed/agents/claude/rules/golang/testing.md
- [[Keychain Services for Secrets]] - document - preseed/agents/claude/rules/swift/security.md
- [[Mandatory Pre-Commit Security Checklist]] - document - preseed/agents/claude/rules/common/security.md
- [[No AI Attribution  Co-Authored-By in Commits]] - document - preseed/agents/claude/rules/cloudflare-environment.md
- [[No Local BuildsTestsLint Rule]] - document - preseed/agents/claude/rules/no-local-builds.md
- [[Override Procedure with User Warning]] - document - preseed/agents/claude/rules/no-local-builds.md
- [[Playwright E2E Framework]] - document - preseed/agents/claude/rules/typescript/testing.md
- [[Post-Push CI Monitoring Obligation]] - document - preseed/agents/claude/rules/git-workflow.md
- [[Project Structure under ~workspaceproject-name]] - document - preseed/agents/claude/rules/cloudflare-environment.md
- [[Python Testing (pytest)]] - document - preseed/agents/claude/rules/python/testing.md
- [[SDD Opt-in Matrix (vibe vs SDD mode)]] - document - preseed/agents/claude/rules/git-workflow.md
- [[Secret Management Rules (env vars, rotation)]] - document - preseed/agents/claude/rules/common/security.md
- [[Security Response Protocol (STOP, security-reviewer agent)]] - document - preseed/agents/claude/rules/common/security.md
- [[Swift Security Rules]] - document - preseed/agents/claude/rules/swift/security.md
- [[Swift Test Isolation (fresh instance per test)]] - document - preseed/agents/claude/rules/swift/testing.md
- [[Swift Testing (Swift Testing framework)]] - document - preseed/agents/claude/rules/swift/testing.md
- [[TypeScriptJavaScript Security]] - document - preseed/agents/claude/rules/typescript/security.md
- [[TypeScriptJavaScript Testing]] - document - preseed/agents/claude/rules/typescript/testing.md
- [[Use GitHub Actions CI for TestsBuildsLint]] - document - preseed/agents/claude/rules/no-local-builds.md
- [[Web-Standard API Mappings for Workers Runtime]] - document - preseed/agents/claude/rules/cloudflare-environment.md
- [[ci-monitoring Skill]] - document - preseed/agents/claude/rules/git-workflow.md
- [[context.Context for Timeouts]] - document - preseed/agents/claude/rules/golang/security.md
- [[deploy-credentials Skill]] - document - preseed/agents/claude/rules/git-workflow.md
- [[git-review-pipeline Skill]] - document - preseed/agents/claude/rules/git-workflow.md
- [[gosec Static Security Analysis]] - document - preseed/agents/claude/rules/golang/security.md
- [[pr-workflow Skill]] - document - preseed/agents/claude/rules/git-workflow.md
- [[process.env Secret Management Pattern]] - document - preseed/agents/claude/rules/typescript/security.md
- [[pytest.mark Categorization (unit, integration)]] - document - preseed/agents/claude/rules/python/testing.md
- [[security-reviewer Agent]] - document - preseed/agents/claude/rules/common/security.md

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Codeflare_Environment_Rules
SORT file.name ASC
```
