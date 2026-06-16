# Product

## Register

brand

## Users

Two audiences, one page:

1. **Agentic and context engineers** — senior engineers who steer fleets of autonomous
   coding agents. They do not want an autocomplete toy; they want an operating model.
   They judge a tool in the first ten seconds by whether it demonstrates real agentic
   capability or just talks about it.
2. **Enterprise buyers** (CTO, CISO, platform/procurement) — evaluating whether
   autonomous agents can be adopted *safely*: security architecture, data boundaries,
   identity integration, cost attribution, compliance. They read the FAQ first.

Context: arriving from a referral, a conference talk, or a search for "enterprise
agentic coding". The job to be done: decide in one scroll whether this is credible
enough to book a demo.

## Product Purpose

Codeflare is **the enterprise agentic engine** — the platform where completely
autonomous coding happens inside the enterprise boundary. The page must carry every
load-bearing selling point (verbatim from the founder):

- **Not a coding assistant.** A tool for agentic and context engineers who steer agents
  during completely autonomous coding — this is what enables 1000% (10×) productivity gains.
- **Enterprise-grade security** (highest focus): isolated ephemeral containers that make
  privilege escalation and unauthorized access to internal systems impossible; zero-trust
  governed; data loss prevention; enterprise IAM integration; everything encrypted at rest;
  compliance guarantees.
- **Scaffolding that superpowers coding agents** (highest focus): enterprise tooling,
  30+ skills, specialist subagents, knowledge-graph memory, data persistence, MCP tooling,
  and browser-isolated web ingestion (agents read the open web through isolated browsers
  that render heavy JavaScript and gated content, distilled into structured markdown built
  for agent ingestion rather than raw HTML).
- **Spec-driven development, enforced** (highest focus): work begins as requirements with
  acceptance criteria; Codeflare both develops under SDD and *enforces* SDD + TDD compliance
  at every PR boundary — a self-healing loop that gives autonomous agents no room to drift
  from the plan.
- **Integration into existing CI/CD workflows** (highest focus): agents are citizens of
  the customer's pipeline — branches, PRs, CI gates, a /review --deep 6-agent review at PR
  boundaries, human triage owning the merge.
- **Beyond code, into operations** (highest focus): the same governed agents reach internal
  infrastructure through zero-trust, policy-scoped tunnels (Cloudflare Access policy gating
  what each session can reach) — orchestrating environments, patching servers, carrying
  migrations, driving incident response. Codeflare operates the systems, not just authors the
  code; every connection is attributed in the customer's own logs, no standing VPN.
- **Total cost control and visibility**: environment cost plus inference cost through
  dynamic routing, cost and rate limiting — all the way down to each coding agent's
  consumption inside each CLI tool; attributed per user / team / department / group via
  metadata. Pay-per-use, no idle fleet. (Enterprise mode: no per-user budgets — unlimited
  use, fully attributed.)
- **Runs in a browser, so it runs everywhere**: nothing to deploy, onboarding is just IAM
  configuration, no workplace device management, no contractor device lifecycle.
- **Fully cloud-delivered inside the enterprise environment**: customer's own tenancy,
  own keys, own data plane, no vendor in the data path.

Success: the visitor says "how was this made?" — then books a demo.

## Brand Personality

Engineered, sovereign, inevitable. The voice of a platform that already works — calm
declarative claims backed by demonstration, never hype adjectives. Cinematic dark, calm
and spare: a single terminal demo shows the engine working, and the rest of the page
speaks in confident prose. The flare is energy under control: a cursor- and
scroll-reactive fluid runs page-wide beneath one calm, constant veil — driven by the
cursor on desktop and by page scroll on touch, and a single gradient accent word carries
the name.

## Anti-references

- "AI coding assistant" landing pages: autocomplete GIFs, IDE screenshots, per-seat
  pricing tables. Codeflare is explicitly *not* a coding assistant.
- SaaS template grammar: an uppercase eyebrow over every section, identical icon-card
  grids in every section, flashy gradient-number stat strips, full gradient headlines.
  (A single restrained metric band and one brand-flare word are fine; templated
  repetition and chaos are not. The page must pass the Impeccable detector and ban list.)
- Public pricing. Enterprise contact only — like graymatter.ch/contact.
- Kiro.dev / CodeConductor visual clichés already saturating the agentic-tools category.

## Design Principles

1. **Show the engine working, then speak plainly.** A single legible terminal demo proves
   real agentic capability up front, and the mono proof artifacts below are camera angles
   on that same run, not unrelated widgets: one pull request (the spine) is followed from
   intent to merge through the self-healing enforcement gate that visibly fails then
   corrects, the boundary data-path with its denied paths at equal weight, the egress
   strip where a DLP redaction is shown happening, the browser-isolation context pipe, the
   parallel review board of six reviewer lanes, and the cost ledger closing on zero
   unattributed. The same IDs recur in each, so the page reads as a system of record, not
   a demo reel. The prose between them stays calm and specific. Showing the agent fail and
   be corrected, and a model call inspected mid-flight, are the moves neither competitor
   dares; they are what make the autonomy credible.
2. **One engineer, many agents.** The 10× operating model — parallel autonomous
   sessions under one person's judgment — is the idea the page must land.
3. **Structural trust.** Security claims are architecture ("the environment ceases to
   exist"), never policy promises. Copy and visuals show boundaries, not badges.
4. **Motion with intent.** A quiet scroll-reveal, the perpetual scramble on the single
   hero accent word (the Codeflare ScrambleText effect), and a cursor- and scroll-reactive
   flare-fluid running page-wide behind the content (one calm, legible wash page-wide;
   the cursor drives it on desktop and page scroll drives it on touch,
   with content panels floating over it as translucent glass).
   A few restrained micro-interactions add life and nothing more: staggered grid reveals,
   one-shot proof-artifact sequences armed on scroll-in (a drift caught then corrected, the
   review lanes streaming in, the ledger rows settling), a primary-CTA hover lift, nav-link
   underlines, a card edge-glow, and a depth seam on the nav once scrolled. All fast,
   GPU-friendly, hover gated to fine pointers. Content is never gated behind animation;
   every proof artifact ships its resolved final state in the markup, and the full
   prefers-reduced-motion fallback stops all movement.
5. **Sans prose, mono for proof.** All copy is set in a clean sans; monospace is
   reserved for the single terminal demo and the code snippet, where it signals real
   engineering. Generous whitespace; one accent, locked.

## Accessibility & Inclusion

- WCAG 2.1 AA: body text ≥4.5:1 against backgrounds, large text ≥3:1.
- `prefers-reduced-motion: reduce` honored everywhere: static transcript, the hero accent
  word stays static (no scramble), the flare-fluid is off (solid surfaces), no parallax, crossfades only.
- All content readable with JavaScript disabled (transcripts render statically).
- Keyboard-navigable nav and FAQ; visible focus states; mobile-first responsive.
