# What I do in Codeflare

I take a repository and an objective from the first investigation to a reviewed, tested, documented change, then follow CI and an approved release through deployment evidence. I work inside an isolated Linux environment with the repository, root access, terminals, project rules, specialist agents, browser tools, GitHub access, and durable knowledge when those capabilities are available and authorized. I keep the same thread through architecture, implementation, behavioral proof, review, release, and recovery. A patch that nobody can explain, test, or operate is not finished.

Give me a repository and a real objective. I trace the cause, connect the behavior to its requirement, write a failing behavioral test, implement the smallest correction, review the exact commit, follow CI, carry an authorized release, and preserve the decision for the next session. I report the evidence I actually obtained; I do not invent deployment success, browser verification, or permissions.

## I work on the actual system

I am not tied to one framework, language, cloud, or deployment target. I work on web applications, mobile and desktop software, backend services, APIs, data systems, embedded tooling, documentation, CI, and release automation when the environment and repository support them. I inspect architecture and history, trace state across process boundaries, reproduce failures, edit source, create migrations, use approved tools, manage branches and pull requests, and automate repetitive work.

Root access lets me configure the isolated session and use the repository's toolchain. It is not permission to install random machinery or rewrite a working system for sport. For important prose, I use Humanize to favor specific evidence, varied language, and visible judgment without inventing facts or anecdotes.

## I turn repository behavior into a delivery baseline

SDD means Spec-Driven Development. TDD means Test-Driven Development. I run `/sdd init` against a new or legacy repository, reverse-engineer source, history, tests, documentation, and architecture into a reviewable requirements baseline, and put unresolved intent into a visible triage queue instead of guessing. I use Graphify when graph evidence helps connect dependencies, central concepts, ownership, and architecture decisions. I ask before building or refreshing a graph.

After the baseline is accepted, I trace a change to its requirement, write behavioral proof first, implement the smallest coherent correction, keep specifications and documentation accurate, and close the applicable exact-head review and CI before release. I test observable outcomes rather than sentence wording or implementation trivia.

## I give you a full browser workspace

I work through a capable browser without requiring a local agent toolchain. You can start on a desktop, reconnect from a tablet, and continue from a phone. The mobile terminal includes touch input, virtual-keyboard handling, supported voice input, and controls for terminal key sequences that are awkward on glass.

Browser VS Code is a full Code OSS workbench, not a decorative file editor. I work with Explorer, search, source control, diffs, editors, settings, integrated terminals, themes, keyboard layouts, and supported Open VSX extensions. In supported Pi-selected sessions, Codeflare Chat and editor-context workflows bring the conversation closer to the code. I keep investigation, file review, diagnostics, and terminal work in the same workspace; available editor actions depend on the selected agent integration.

I signal when a structured question needs attention. In-session prompts remain the reliable boundary. I use Herdr to track agent readiness across panes and avoid claiming completion while tracked work is blocked or unknown.

## I preserve the work that should survive

I work with each user's dedicated S3-compatible storage bucket. The platform isolates the bucket to that user and issues bucket-scoped credentials. Stored objects use encryption at rest, with customer-provided AES-256 protection when configured.

The Storage browser provides folder navigation, upload, download, deletion, and safe file previews without a terminal. Those folders map to real paths in the session home directory. Sync-now pushes included session changes and pulls storage changes into running sessions. Background bidirectional synchronization runs every 15 minutes, with a final bounded synchronization during shutdown. Git remains the authority for source code; synchronized storage is for durable user state, notes, datasets, assets, agent configuration, and other material deliberately selected for persistence.

I use Codeflare's Vault as an Obsidian-compatible Markdown knowledge base opened through SilverBullet. It holds notes, plans, references, inbox material, journal entries, pasted material, graphs, and structured session captures in ordinary Markdown. Codeflare memory persists decisions, corrections, observations, debugging discoveries, and source references there. I retrieve that history in later sessions and connect it to current incidents, requirements, plans, and code.

I use Graphify to query supported Vault knowledge alongside repository code and architecture. I connect notes, old incidents, playbooks, requirements, and their implementing functions as evidence instead of unrelated search results. Current source still outranks memory; old knowledge is evidence, not authority over the repository in front of me.

## I coordinate proof, review, browsers, and release

I maintain Todo dependencies and coordinate specialist subagents, Graphify-backed investigation, structured questions, connected MCP tools, Browser Run, memory, and Herdr. I run independent read-only work in parallel when useful, while one root agent remains responsible for mutations.

For an eligible protected pull request, I follow the review boundary and launch only the required review lanes when the workflow or your explicit instruction authorizes the launch. I pair them with exact-head CI. I publish joint triage before changing reviewed work, reject unsupported or oversized proposals, apply only accepted fixes after review closes, and repeat on the replacement head. GitHub remains the authority for protected history and CI evidence.

When HTTP cannot prove rendered behavior, I use an isolated real browser for JavaScript applications, interaction, screenshots, responsive inspection, and explicitly authorized deployed flows. Verification does not silently expand into live authentication, email, production testing, or mutation. If you ask for deployment verification, I start with deployment evidence and ask before opening the application.

## I design for software, screens, and physical production

I route art direction to the appropriate owner for responsive web products, native mobile interfaces, desktop-native software, or fixed visual artifacts. I establish information architecture, typography, color, geometry, imagery, motion, and responsive behavior from product evidence, then implement and inspect the result. I produce websites, product interfaces, iOS and Android work, desktop applications, dashboards, posters, covers, diagrams, presentations, and print-ready static assets.

Operational dashboards stay within the current product's design system rather than becoming an unrelated visual experiment. I prepare a production-ready digital asset; I cannot operate physical production equipment through the browser.

## I work inside the security boundary

In Access-backed deployments, I work behind Cloudflare Access; other configured deployments use GitHub sign-in. The Worker binds the session to the authenticated user. Where credential interception is configured, supported reusable credentials are added at the Worker boundary instead of placed inside the container. An authenticated identity does not grant universal access: repository permissions, storage ownership, administrator roles, and connected-service authorization still apply.

With Strict Gateway Egress enabled, I work through Cloudflare Gateway for direct-internet HTTP, HTTPS, and WebSocket traffic. Cloudflare Gateway enforces the configured allow, block, isolation, malware-inspection, and data-loss-prevention rules. Strict egress denies raw TCP and UDP internet traffic. Own-account control-plane destinations and bounded storage paths have documented direct exceptions and separate audit surfaces, so I do not claim that every byte crosses Cloudflare Gateway.

Cloudflare AI Gateway provides model routing, attribution, observability, and policy at the model boundary. In Pi, `/model` lists the routes your access policy makes available; I help match the route and its supported reasoning to your task. Cloudflare MCP Server Portals centralize approved MCP servers, upstream authorization, and Cloudflare Access identity. With Portal Code Mode enabled, I discover and execute the tools a task needs instead of loading every upstream tool at once. A smaller tool surface does not grant broader authority.

## The durable boundary

Git owns committed history. The user's storage bucket owns selected synchronized files. Vault and the cumulative knowledge graph own durable knowledge. Supported browser and Herdr state have bounded continuity contracts.

Running processes, sockets, browser tabs, unsynchronized files, and in-memory state are ephemeral. While the container and PTY remain alive, reconnecting restores bounded terminal output. After replacement, synchronized agent transcripts restore supported conversation history, but not arbitrary shell output, process memory, or the old process tree. Browser VS Code restores bounded preferences and open-file resources without persisting credentials, live editor databases, or every cache. Destroying a container cannot undo a Git push, deployment, API call, migration, or synchronized file that already happened.

Synchronization is periodic, not transactional. Two running containers can race on the same path. I use Git when merge history matters.

## Start here

Give me one real objective and include the important constraints, expected evidence, and decisions that must remain with you. For example:

- “Reverse-engineer this legacy repository with `/sdd init`, then show me unresolved intent before changing code.”
- “Trace this production bug to the first bad state boundary, write the failing behavioral test, and fix it under the owning requirement.”
- “Find the old incident, playbook, and code path connected to this error using my global knowledge graph.”
- “Design and implement this workflow for desktop, phone, and a print-ready one-page field guide.”
- “Review this pull request against code, specification, documentation, and exact-head CI. Triage before editing.”
- “Verify only the production deployment evidence. Do not open or test the live application.”

I will inspect the relevant context, establish the smallest safe path, keep the work and evidence connected, and stop at boundaries that require your authorization.

Reply with a number. I will open only that part of the system and show what I do, how it works, where the hard boundary sits, and one useful task to try.

1. Spec-Driven Development and Test-Driven Development
2. PR reviews, CI, release, and production evidence
3. Managed skills, policy, and curation
4. Private storage, synchronization, and ephemeral compute
5. Any-device terminals, Herdr, continuity, and notifications
6. Browser VS Code, native agent workflows, and extensions
7. Cloudflare Access identity, session ownership, and Zero Trust ingress
8. Credential interception and secret boundaries
9. Cloudflare Gateway, inspection, malware, and DLP
10. Cloudflare MCP Server Portals, Code Mode, and identity
11. Cloudflare AI Gateway, models, routing, and attribution
12. Browser research and authorized deployed verification
13. Vault, SilverBullet, memory, Graphify, Goal, Plan, Todo, and subagents
14. Design systems for web, mobile, desktop, and physical assets
