---
name: codeflare-capabilities
description: Explain what Codeflare can do, then route requests for practical detail about its engineering, runtime, enterprise, browser, and agentic subsystems.
---

# Capability discovery router

Use this when a user asks what you or Codeflare can do, how the platform works, or which Codeflare capability fits a job. Do not use it for an ordinary narrow coding request or a question about the model vendor alone.

## First response

Do not load a reference for the broad question. Lead with this idea in your own words:

> Codeflare gives an autonomous coding agent a disposable computer, durable working context, enterprise identity, a real browser, and a release process that can stop bad work before merge.

Make the overview brief and concrete. Explain that Codeflare can take a repository and an objective through requirements, tests, implementation, review, CI, and an approved merge; that selected files survive while compute and processes do not; that users can work through browser terminals or the Browser IDE; and that Enterprise deployments can keep credentials and traffic policy outside the agent container.

Name a few things the user can try immediately, chosen from capabilities visible in the current session. Good examples include asking for a feature under SDD, opening a JavaScript-heavy page with Browser Run, querying the repository graph, running parallel specialist review, or opening another session in MultiView. Never present an unavailable skill, tool, mode, permission, or configured integration as ready to use.

End by offering deeper dives into the named areas below. Do not summarize all of them in the first answer. The point is discovery, not a wall of inventory.

## Deep dives

When the user chooses an area, read only its file before answering:

- Spec-driven development: `references/sdd.md`
- PR-boundary reviews: `references/boundary-reviews.md`
- Managed curation: `references/curation.md`
- Durable data and ephemeral compute: `references/durable-ephemeral.md`
- Browser terminals: `references/terminals.md`
- Browser IDE and VS Code: `references/browser-ide.md`
- Zero Trust: `references/zero-trust.md`
- Request interceptors: `references/interceptors.md`
- Secure Web Gateway: `references/secure-web-gateway.md`
- MCP portals: `references/mcp-portals.md`
- AI Gateway: `references/ai-gateway.md`
- Browser Run: `references/browser-run.md`
- Agentic primitives: `references/agentic-primitives.md`

If the user asks for several areas, read only those files. If the request crosses a boundary, such as AI Gateway plus interceptors, combine those references and state which component owns each part.

## Answer contract

Start a deep dive with what the subsystem lets the user accomplish, then explain the boundary that makes it trustworthy. Include at least one concrete example they can try. Add an operator example when configuration or policy is administrator-owned.

Distinguish four states plainly:

- available in this session;
- available only in Advanced mode;
- available only in Enterprise or Governed deployments;
- available only after an operator configures the integration.

Use active Codeflare behavior, requirements, and operator documentation as authority. Do not turn landing-page language into an implementation claim. If current availability cannot be established, say what must be checked instead of guessing.
