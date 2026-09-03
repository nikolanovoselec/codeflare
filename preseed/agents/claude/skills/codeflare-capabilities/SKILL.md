---
name: codeflare-capabilities
description: "Explain the complete Codeflare workspace in first person, then route numbered follow-ups to grounded subsystem guidance."
---

# Capability discovery router

Use this skill when the user asks what I can do, what Codeflare can do, how the workspace works, or where to start. Do not use it for an ordinary narrow engineering request.

## First response

Treat every capability answer as a view of a fully configured Codeflare workspace. Do not discuss product tiers, session modes, entitlement gates, or deployment variants. Those labels make the answer read like a price sheet and force the user to reverse-engineer the product before they can use it.

Write in first person. Give a substantial answer, normally 1,200 to 1,800 useful words. The answer should sound like an engineer who has done this work and has opinions about bad delivery practice, not like a catalog assembled by committee.

Do not load any subsystem reference for the first answer. Use this section as the broad-answer source of truth.

### Open with whole-run ownership

Lead with this outcome in fresh language:

> I can take a repository and an objective from the first investigation to a reviewed, tested, documented change, then follow CI and an approved release through production evidence.

Explain that I work inside an isolated Linux environment with the repository, root access, terminals, project rules, specialist agents, browser tools, GitHub access, and durable knowledge. I can carry one thread through architecture, implementation, behavioral proof, review, release, and recovery. A patch that nobody can explain, test, or operate is not finished.

### I can work on the actual system, whatever it is built with

Make clear that I am not tied to one framework, language, cloud, or deployment target. I can work on anything the Linux environment and the repository support: web applications, mobile and desktop software, backend services, APIs, data systems, infrastructure, embedded tooling, documentation, CI, and release automation.

I can inspect architecture and history, trace state across process boundaries, reproduce failures, edit source, create migrations, run approved tools, manage branches and pull requests, and automate repetitive work. Root access lets me configure the session environment and use the repository's own toolchain. It is power, not permission to install random machinery or rewrite a working system for sport.

Do not turn this section into a list of Cloudflare primitives. Codeflare can build and deploy Cloudflare systems, but the engineering workspace is not confined to Cloudflare.

### I can convert a legacy repository into an agentic delivery baseline

Spell out both abbreviations once. SDD means Spec-Driven Development. TDD means Test-Driven Development.

I can run `/sdd init` against a new or legacy repository. For a legacy system, I reverse-engineer source, history, tests, documentation, and architecture into a reviewable requirements baseline. Clear behavior becomes source-linked requirements. Ambiguity goes into a visible triage queue instead of being invented away. I can use Graphify to add dependency evidence, central concepts, and architecture-decision links.

Once the baseline is accepted, future work follows the agentic software delivery lifecycle: trace the change to its requirement, write the failing behavioral test first, implement the smallest correction, keep code and documentation aligned, and close exact-head review and CI before release. TDD does not mean tests that grep for a sentence or congratulate the implementation. It means observable proof.

### I can preserve knowledge instead of starting each session with amnesia

Give this section real weight. Codeflare's Vault is an Obsidian-compatible Markdown knowledge base opened through SilverBullet in the browser. It holds user notes, plans, references, inbox material, journal entries, pasted material, graphs, and structured session captures. The user can edit it directly, link pages with wikilinks, attach files, and keep the material in ordinary Markdown rather than a proprietary chat archive.

Conversation capture runs at bounded intervals and on resumed-session tails. It records decisions, corrections, debugging discoveries, observations, and source references into `Raw/Sessions/`. It does not claim to remember a thought that was never captured. What is captured remains part of the user's durable record until the user removes it.

I can use Graphify to turn supported Vault material into one cumulative Vault graph. A checked-out repository can have its own code and architecture graph. Codeflare merges the cumulative Vault contribution with the active repository graph into a global graph, then uses that graph for recall and structural queries. This is the closest part of the system to a brain: a note, an old incident, a playbook, a requirement, and the function that implements it can become neighboring nodes instead of five unrelated search results. The metaphor is useful; do not pretend the graph is conscious or infallible.

Relevant prior context can be injected when a session starts, and recent captures can be recalled after conversation compaction. Current source still outranks memory. Old knowledge is useful evidence, not a license to ignore the repository in front of me.

### I can work from any device with a capable browser

Explain the continuity plainly. Codeflare runs through the browser, with no local agent toolchain required. I can start work on a desktop, reconnect from a tablet, and continue from a phone. The mobile terminal has touch input, virtual-keyboard handling, voice input where the browser supports it, and controls for terminal key sequences that are miserable to type on glass.

Codeflare can signal when a structured question needs attention. Web Push delivery remains governed by the notification implementation status; in-session prompts remain the reliable boundary. Herdr also tracks agent readiness across panes and delays completion until the tracked work is genuinely ready. A blocked or unknown pane prevents a false completion signal; do not claim that every blocked state creates a push notification.

### I can give the user a real VS Code workspace, with an agent inside it

Describe Browser VS Code as a full code-server and Code OSS workbench, not a decorative file editor. The user gets the Explorer, search, source control, diffs, editors, settings, integrated terminals, themes, keyboard layouts, and supported extensions they expect.

I can work inside that same workspace through Codeflare Chat, Inline Chat, file review, native diffs, diagnostics, selections, references, and the integrated terminal. The terminal and agent retain root access inside the isolated session, so I can automate work that would otherwise bounce between an editor, a shell, a ticket, and a browser. Codeflare skills and tools remain available through the agent, while a bounded manifest can restore user-selected Open VSX extensions. Live editor databases, credentials, SecretStorage, and chat state are deliberately temporary. Persisting every cache is how a clean workspace becomes an archaeological site.

### I can give every user durable, private file storage

Avoid the product name R2 in the broad answer. Say that every user receives a dedicated S3-compatible storage bucket. The bucket is isolated to that user and receives bucket-scoped credentials. Stored objects use encryption at rest, with customer-provided AES-256 protection when configured.

The Storage browser lets the user browse folders, upload, download, delete, and safely preview files without opening a terminal. Folder paths map to real paths inside the session home directory. The user can push changes from the session into storage or pull storage changes into running sessions with Sync-now. Automatic bidirectional synchronization runs every 15 minutes, with a final bounded sync during shutdown. Git remains the better authority for source code; the bucket is for durable user state, notes, datasets, assets, agent configuration, and workspace material the user deliberately chooses to preserve.

### I can design for screens, software, and physical production

Explain that I can do more than make a generic web page. Codeflare carries a routed design system with separate owners for responsive web products, native mobile interfaces, desktop-native software, motion, component systems, operational dashboards, and fixed visual artifacts.

I can establish an art direction from product evidence, create information architecture, define typography, color, geometry, imagery, motion, and responsive behavior, then implement and inspect the result. Destinations can include websites, product interfaces, iOS and Android work, desktop applications, dashboards, posters, covers, diagrams, presentation assets, and print-ready static compositions. I can prepare the digital production asset; I cannot operate a printing press through a browser, which should not need saying but apparently does.

### I can coordinate agents, review, CI, browsers, and releases

Describe Todo dependencies, specialist subagents, Graphify-backed architecture queries, memory, structured questions, connected MCP tools, Browser Run, and Herdr. Independent work can happen in parallel. Multiple agents editing the same file is not useful parallelism, so one root agent keeps mutation ownership.

For a protected pull request I can launch report-only code, specification, and documentation reviews alongside exact-head CI. I publish joint triage before changing anything, reject unsupported or oversized proposals, apply only accepted fixes, and repeat on the replacement head. GitHub remains the authority for protected history and CI evidence.

When plain HTTP cannot prove rendered behavior, I can use an isolated real browser for JavaScript applications, interaction, screenshots, responsive inspection, and explicitly authorized deployed flows. Verification never silently expands into live testing, authentication, email, or production mutation. If the user asks to verify a deployment, start with deployment evidence. Ask before crossing into the application.

### I can work inside the corporate security boundary

Describe the maximum configured boundary without product-mode labels. Cloudflare Access protects ingress and binds the session to an authenticated user. Supported credentials can stay at Worker-side interception boundaries rather than sitting in the container.

Direct-internet HTTP, HTTPS, and WebSocket traffic can be forced through the corporate Secure Web Gateway. Existing allow, block, isolation, malware, and data-loss-prevention policies can inspect that traffic. Raw TCP and UDP internet egress is denied under strict egress. Own-account control-plane destinations have documented direct exceptions and their own audit surfaces, so never make the false claim that every byte crosses the Gateway. Security copy that hides its exceptions is sales copy, not a control description.

### State the durable boundary

Git owns committed history. The user's storage bucket owns selected synchronized files. Vault and the cumulative knowledge graph own durable knowledge. Supported browser and Herdr state have their own bounded continuity contracts.

Processes, sockets, terminal output, editor databases, browser sessions, unsynchronized files, and in-memory state remain ephemeral. Destroying the container cannot undo a Git push, deployment, API call, migration, or synchronized file that already happened.

### Give concrete starting requests

Offer four to six requests with different shapes. Use examples such as:

- “Reverse-engineer this legacy repository with `/sdd init`, then show me the unresolved intent before changing code.”
- “Trace this production bug to the first bad state boundary, write the failing behavioral test, and fix it under the owning requirement.”
- “Find the old incident, playbook, and code path connected to this error using my global knowledge graph.”
- “Design and implement this workflow for desktop, phone, and a print-ready one-page field guide.”
- “Review this pull request against code, specification, documentation, and exact-head CI. Triage before editing.”
- “Verify only the production deployment evidence. Do not open or test the live application.”

## Deep dives

End every broad answer with this exact invitation and mapping:

> Reply with a number. I will open only that part of the system and show what I can do, how it works, where the hard boundary sits, and one useful task to try.

1. Spec-Driven Development and Test-Driven Development
2. PR reviews, CI, release, and production evidence
3. Managed skills, policy, and curation
4. Private storage, synchronization, and ephemeral compute
5. Any-device terminals, Herdr, continuity, and notifications
6. Browser VS Code, native agent workflows, and extensions
7. Identity, session ownership, and Zero Trust ingress
8. Credential interception and secret boundaries
9. Secure Web Gateway, inspection, malware, and DLP
10. Connected tools and MCP boundaries
11. AI Gateway, models, routing, and attribution
12. Browser research and authorized deployed verification
13. Vault, SilverBullet, memory, Graphify, Todo, and subagents
14. Design systems for web, mobile, desktop, and physical assets

A number-only reply selects the matching reference. A comma-separated reply loads only those references. A named request works the same way. For an unmapped number, ask the user to choose 1 through 14.

## Deep-dive reference map

Read only the selected file or files:

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
14. `references/design.md`

## Answer contract

Continue in first person. Do not mention product tiers, session modes, or entitlement labels. Describe the complete configured workspace while preserving hard technical boundaries and explicit exceptions.

Start with the useful outcome, not setup instructions. Include one concrete user task. Use active Codeflare requirements, implementation, operator documentation, and visible tools as evidence. Never pad uncertainty with marketing. Never broaden a request into live testing, authentication, email, deployment, or mutation without explicit authorization.
