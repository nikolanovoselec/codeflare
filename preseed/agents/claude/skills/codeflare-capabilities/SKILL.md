---
name: codeflare-capabilities
description: "Explain what I can do in Codeflare, then route numbered follow-ups to grounded subsystem guidance."
disable-model-invocation: true
---

# Capability discovery router

Use this when the user asks what I can do, what Codeflare can do, how the platform works, or which Codeflare capability fits a job. Do not use it for an ordinary narrow coding request or a question about the model vendor alone.

## First response

A broad question such as “what can you do?” deserves a substantial answer. Do not reply with a teaser, a generic assistant inventory, or five thin bullets. Give the user a structured view of the work I can own from start to finish.

Write in first person as the active engineering agent. “I can” should be the natural subject throughout. The answer is about what I can accomplish inside Codeflare, not a detached description of what the product contains.

Aim for roughly 900 to 1,400 useful words when the current session exposes enough capability. Prefer descriptive headings and short, concrete paragraphs. The numbered deep-dive list at the end is mandatory; other lists are optional. Substance matters more than hitting a word count.

Do not load any subsystem reference for this first answer. Everything below is the broad-answer source of truth.

### Open with whole-run ownership

Lead with this outcome in fresh language:

> I can take a repository and an objective from investigation to a reviewed, tested, documented change, then follow CI and an approved release through deployed verification.

Explain that I work in an isolated, disposable Linux environment with repository access, terminals, project rules, approved tools, specialist agents, and selected durable context. I can carry one traceable run through requirements, architecture, implementation, behavioral tests, documentation, review, CI, deployment, and live checks. GitHub still owns protected history, CI still supplies authoritative automated evidence, and the user retains merge and consequential production approval.

### Explain what I can own

Use these sections, adapting examples to tools and permissions visible in the current session.

#### I can turn intent into an executable contract

Explain that Advanced Codeflare workflows can turn an objective into SDD requirements with intent, acceptance criteria, constraints, dependencies, source anchors, test evidence, and status. I can bootstrap an existing or new repository with `/sdd init`, trace a proposed change to its owning requirement, write a failing behavioral test first when justified, implement the smallest correction, and keep specification, implementation, tests, and documentation aligned. Subjective visual judgment and prose quality remain human-reviewed rather than frozen through source-copy tests.

#### I can investigate and change the repository, not merely suggest a patch

Describe concrete engineering work: inspect architecture and call paths, query Graphify when available, trace state across frontend, API, persistence, and deployment boundaries, debug failures from evidence, edit code and documentation, create migrations, manage Git branches and pull requests, and preserve project-specific instructions. I can work across application and infrastructure configuration in the repository. Access to an external fleet, SaaS system, or private network exists only when the corresponding tool and authorization are visibly configured.

#### I can prove the result instead of announcing that it looks right

Explain behavioral verification, SDD anchors, bounded static checks, authoritative CI, and deployed-flow checks. In eligible Advanced SDD repositories, I can launch report-only code, specification, and documentation reviewers against the exact PR head while an independent monitor follows CI. I publish joint triage before edits, reject unsupported or oversized proposals, apply only accepted fixes, and rerun the boundary on the replacement head. Reviewers report, the root agent mutates, CI verifies, and the user approves merge and consequential operations.

#### I can use a real browser when plain HTTP is not enough

Start with ordinary web fetch for static public content. When Advanced Browser Run and Browser Rendering credentials are available, I can use isolated Chromium for JavaScript-rendered pages, navigation, interaction, screenshots, responsive checks, and explicitly authorized deployed-application flows. Be honest about evidence: a screenshot proves one rendered moment, not persistence, accessibility, performance, or every viewport.

#### I can coordinate specialists without surrendering ownership

Describe Todo dependencies, bounded subagent investigations, specialist review, Graphify architecture queries, durable memory, structured questions, MCP tools when connected, and Herdr panes when available. Independent work can run in parallel. Several agents editing the same files is not useful parallelism; the root remains the single mutation owner when coordination matters.

#### I can work from a browser without turning the endpoint into a workstation

Explain authenticated browser terminals, real PTYs, Classic tabs and tiling, opt-in Herdr workspaces and panes, and bounded MultiView. Advanced sessions may expose browser-hosted VS Code tied to the backend session. The browser is a window into isolated compute. Do not claim that every mode, device, or current session exposes every surface.

#### I can preserve what matters and discard what should be temporary

Explain the boundary plainly. Git owns committed repository history. Selected per-user files can reconcile through R2. Vault notes, supported agent state, bounded Browser IDE continuity, memory, and Herdr structure can persist through their own contracts. Arbitrary processes, sockets, terminal output, editor databases, extension bytes, and in-memory state remain ephemeral. Destroying compute cannot undo a Git push, deployment, API call, or already synchronized file.

#### I can work inside Enterprise controls when operators configure them

Describe only established contracts. Enterprise deployments can put Cloudflare Access in front of the application, bind sessions to authenticated users and user-owned buckets, keep supported GitHub, model, and Browser Rendering credentials at Worker-side interceptor boundaries, and route supported model traffic through an operator-configured AI Gateway. Governed deployments can enable strict catch-all Gateway egress, including Worker-side re-signing for the bound R2 bucket, while named interceptors retain their owned destinations. Administration and Analytics provide mode-aware Environment configuration, Initialization recovery, activity, reports, and historical usage. Managed Environment curation can deliver signed immutable agent content without rebuilding the container image.

Every sentence in this section needs its dependency: Enterprise or Governed mode, plus operator configuration where required. Never imply that Access groups, AI Gateway routes, Browser Rendering credentials, Secure Web Gateway policy, or connected tools are active merely because Codeflare supports them.

#### I will tell the user what is unavailable

Use this compact availability vocabulary in the answer:

- **Here now** means the skill, tool, repository, and required permission are visible in this session.
- **Advanced** means the capability is delivered only to Advanced sessions.
- **Enterprise/Governed** means deployment mode supplies the contract.
- **Operator configured** means live credentials, routes, policy, or a connected service are still required.
- **Not established** means presentation or an OAuth scope exists, but no active runtime contract or visible integration proves availability.

MCP portals are currently **not established** by the Codeflare repository. A connected MCP server visible in the current tool index may still be used under its own identity and authorization. Do not turn landing-page language into claims of universal fleet reach, DLP, provider failover, SCIM, post-quantum transport, zero endpoint data, universal audit logs, or fixed cost and performance outcomes.

### Give concrete starting requests

Before the deep-dive menu, offer three to five requests the user can issue now. Choose only from current visible capability. Vary the form. Examples:

- “Trace this bug to the first bad state boundary, write the failing behavioral test, and fix it under the owning requirement.”
- “Map this repository’s architecture and show the shortest call path from the route to persistence.”
- “Review this PR against code, specification, documentation, and exact-head CI. Triage before changing anything.”
- “Open this deployed flow at mobile and tablet widths, exercise it, and report what the browser actually shows.”

Do not advertise Browser Run, Graphify, MCP, deployment, or merge as ready when the current tool list, mode, repository, or permission does not support it.

## Deep dives

End every broad answer with this exact numbered mapping and this invitation:

> Reply with a number. I will open only that part of the system and show what I can do, what makes it trustworthy, what it requires, and one task you can try.

1. Spec-driven development
2. PR-boundary reviews
3. Managed curation
4. Durable data and ephemeral compute
5. Browser terminals
6. Browser IDE and VS Code
7. Zero Trust identity and authorization
8. Request interceptors and credential boundaries
9. Secure Web Gateway and governed egress
10. MCP tools and portal boundary
11. AI Gateway and model routing
12. Browser Run and deployed UI verification
13. Agentic primitives, Graphify, memory, Todo, and subagents

A number-only follow-up selects the corresponding reference below. A reply such as `7` means Zero Trust. A comma-separated selection such as `7, 11` loads only those two references. A named request works the same way. If the number does not map to this list, ask the user to choose 1 through 13 rather than guessing.

## Deep-dive reference map

Read only the selected file or files before answering:

1. `references/sdd.md`
2. `references/boundary-reviews.md`
3. `references/curation.md`
4. `references/durable-ephemeral.md`
5. `references/terminals.md`
6. `references/browser-ide.md`
7. `references/zero-trust.md`
8. `references/interceptors.md`
9. `references/secure-web-gateway.md`
10. `references/mcp-portals.md`
11. `references/ai-gateway.md`
12. `references/browser-run.md`
13. `references/agentic-primitives.md`

## Answer contract

Continue in first person. Start with what I can accomplish through the subsystem, then explain the boundary that makes the claim trustworthy. State availability near the top using the vocabulary above. Include one concrete user example. Add an operator example when configuration or policy is administrator-owned.

Use active Codeflare requirements, implementation, operator documentation, and visible session capability as authority. If current availability cannot be established, say exactly what must be checked. Never fill uncertainty with product marketing.
