/**
 * All landing-page copy and structure, typed. Components render this data;
 * none carry their own content. Leads may contain inline HTML (em/strong) and
 * are build-time trusted content rendered via set:html.
 */
import { CONTACT_TOPICS, type ContactTopic } from '../../../src/lib/contact-topics';

export interface NavLink {
  label: string;
  href: string;
}

export interface Cta {
  label: string;
  href: string;
}

export interface Card {
  title: string;
  body: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

/** A row in the self-healing enforcement gate (method section proof artifact). */
export interface GateStep {
  actor: string;
  /** fail = drift caught (coral), work = agent correcting (cyan), pass = green. */
  state: 'fail' | 'work' | 'pass';
  text: string;
}

/** A row in the egress-inspection strip (security section proof artifact):
 *  one outbound model call inspected at the AI Gateway boundary. */
export interface EgressRow {
  actor: string;
  /** pass = control satisfied (green); redact = DLP masked a field (amber). */
  state: 'pass' | 'redact';
  label: string;
  text: string;
}

/** A row in the security boundary artifact: an approved path (pass, green) or a
 *  path the architecture makes impossible (deny, coral). Same gate grammar as
 *  the enforcement gate and egress strip, so security reads as one receipt. */
export interface BoundaryRow {
  actor: string;
  state: 'pass' | 'deny';
  label: string;
  text: string;
}

/** A lane in the parallel review board (pipeline section proof artifact). */
export interface ReviewLane {
  agent: string;
  /** clean = verified straight through; finding = caught, fixed, re-proven. */
  result: 'clean' | 'finding';
  note: string;
}

/** A row in the cost attribution ledger (cost section proof artifact). */
export interface LedgerRow {
  time: string;
  user: string;
  team: string;
  agent: string;
  route: string;
  cost: string;
}

/** A grouped total in the cost ledger footer. */
export interface LedgerTotal {
  label: string;
  value: string;
  /** The "unattributed $0.00" line is accented as the load-bearing claim. */
  accent?: boolean;
}

export interface TopicOption {
  value: ContactTopic;
  label: string;
}

/** A single static terminal line with its display tone (CSS suffix). */
export interface TranscriptLine {
  tone: 'cmd' | 'agent' | 'ok' | 'dim' | 'warn' | 'deny';
  text: string;
}

/** A coding-agent statusline footer under a terminal: context / model /
 *  reasoning, the segments a real session shows. The hero foot is gently
 *  animated (context ticks, an occasional compaction beat); reduced motion
 *  leaves it static. */
export interface TerminalFoot {
  ctx: string;
  model: string;
  reason: string;
  note?: string;
}

/** A compact feature terminal: one codeflare capability shown as a real
 *  command and its output, with a one-line caption foot. The grid of these
 *  replaces the old stat band and the old checkmark comparison. */
export interface FeatureTerminal {
  title: string;
  lines: TranscriptLine[];
  foot: string;
  /** Short commands the live prompt line types then deletes in a loop
   *  (feature-terminals.ts), staggered so the four are never in sync. */
  loop?: string[];
}

// The nav doubles as the page's lens on the five enterprise concerns for
// agentic coding: Velocity (the leap), Quality (correct, spec-aligned, reviewed
// output), Security (the zero-trust boundary), Control (you own intent and the
// merge), and Cost (no unattributed spend). Each label points at the section
// that proves it; labels are the category, the section headline is the claim.
export const NAV_LINKS: NavLink[] = [
  { label: 'Velocity', href: '#shift' },
  { label: 'Quality', href: '#method' },
  { label: 'Security', href: '#security' },
  { label: 'Control', href: '#pipeline' },
  { label: 'Cost', href: '#cost' },
];

/**
 * Per-section eyebrow labels ("the kicker spine"). A small uppercase accent
 * label opens every top-level section: the calm structural cue that replaced the
 * old numbered spine, so a reader can feel where each section starts without a
 * counter or a divider rule. The five that match a nav pillar (shift/method/
 * security/pipeline/cost) reuse the pillar word so clicking the nav lands on a
 * section whose eyebrow echoes the link. Keyed by section id; rendered uppercase.
 */
export const SECTION_KICKERS: Record<string, string> = {
  shift: 'Velocity',
  method: 'Quality',
  legacy: 'Adoption',
  security: 'Security',
  context: 'Context',
  pipeline: 'Control',
  orchestration: 'Observability',
  cost: 'Cost',
  platform: 'Platform',
  mcp: 'Tooling',
  dogfood: 'Proof',
  faq: 'FAQ',
  contact: 'get-started',
};

export const AGENTS = ['claude-code', 'codex', 'copilot', 'pi', 'antigravity', 'opencode'];

export const HERO = {
  kicker: {
    prefix: 'The agentic',
    words: ['coding', 'operations', 'testing', 'review', 'orchestration', 'deployment', 'toolchain', 'security'],
    suffix: 'engine',
  },
  headline: { plain: 'This is not', flare: 'a coding assistant.' },
  // The plain one-sentence answer to the headline's hook, rendered in the terminal
  // white directly under the h1: what it is (a platform), what it does (agents
  // build -> ship), where (your trust boundary), and the differentiator a coding
  // assistant cannot claim (an enforcement loop that makes drift impossible).
  definition:
    'Codeflare runs governed engineering agents inside your own estate. Each change is backed by a ' +
    'spec, proven by tests, documented, and handed to your team to approve, whether that is a ' +
    'pull request to merge or a change to run.',
  primaryCta: { label: 'Book a demo', href: '#contact' } satisfies Cta,
  secondaryCta: { label: 'See the shift', href: '#shift' } satisfies Cta,
};

/**
 * The spine: one real pull request followed from intent to merge across the
 * whole page. The same IDs recur verbatim in the hero terminal, the enforcement
 * gate, the review board, and the cost ledger, so four proof artifacts read as
 * four camera angles on one change moving through the engine. Sourced once here
 * so the IDs can never drift out of sync between artifacts.
 */
export const SPINE = {
  req: 'REQ-PAY-014',
  ac: 'AC3',
  pr: 'PR #207',
  user: 't.anderson',
  team: 'payments',
  service: 'payments-service',
};

export const TERMINAL = {
  title: `codeflare · ${SPINE.service}`,
  lines: [
    { tone: 'cmd', text: `${SPINE.user}@metacortex.ai $ /sdd implement ${SPINE.req}` },
    { tone: 'agent', text: '✻ ephemeral container · your tenancy' },
    { tone: 'agent', text: '✻ TDD enforced, tests are the contract between specs, docs and code' },
    { tone: 'warn', text: '⚠ drift · blocking finding' },
    { tone: 'agent', text: '✻ isolated browser launched, markdown extracted' },
    { tone: 'cmd', text: '/review --deep · 6 agents' },
    { tone: 'deny', text: '✕ direct provider call denied' },
    { tone: 'dim', text: '  → redirected to AI Gateway, DLP enforced, guardrails deployed' },
    { tone: 'ok', text: '✓ spec · code · docs aligned' },
    { tone: 'ok', text: `✓ ${SPINE.pr} ready · CI green · you merge` },
  ] satisfies TranscriptLine[],
  foot: {
    ctx: 'context 18%',
    model: 'opus-4.8',
    reason: 'reasoning high',
    note: SPINE.service,
  } satisfies TerminalFoot,
  // The hero prompt's bottom line is a capability reel: one highlight per beat,
  // typed/held/deleted and shuffled on each load (data-ft-shuffle in Hero.astro),
  // looping continuously so the reel never stops. Reduced motion / no JS: run[0]
  // is the server-rendered resting state, fully legible.
  run: [
    'spec-driven · enforced, not suggested',
    'legacy codebase · bootstrapped to an SDD baseline',
    'agents · inside your pipeline, not around it',
    'drift impossible by design',
    'knowledge graph · skills and tools · MCP',
    'cost attributed · dynamically routed',
    'codeflare built this page',
  ],
};

/**
 * Feature terminals: four short, real moments from inside the boundary, each
 * one codeflare capability shown as a command and its output. They replace the
 * old big-number stat band and the old checkmark comparison with the proof
 * idiom the page already trades in. The spine IDs recur so they read as the
 * same governed run from four more angles. Lines are kept short so they wrap
 * cleanly on a phone instead of scrolling sideways.
 */
export const FEATURE_TERMINALS: FeatureTerminal[] = [
  {
    title: 'codeflare · gateway',
    lines: [
      { tone: 'cmd', text: 'agent → api.openai.com' },
      { tone: 'deny', text: '✕ direct egress denied' },
      { tone: 'dim', text: '→ rerouted · your AI Gateway' },
      { tone: 'ok', text: '✓ 41 calls · every token attributed' },
    ],
    foot: 'guardrails on · DLP on egress · your keys',
    loop: ['tail egress.log', 'audit 41 calls', 'list approved models'],
  },
  {
    title: 'codeflare · session',
    lines: [
      { tone: 'cmd', text: 'open session' },
      { tone: 'agent', text: '✻ ephemeral container · your tenancy' },
      { tone: 'ok', text: '✓ 0 lines on the endpoint device' },
      { tone: 'ok', text: '✓ destroyed on exit · 0 standing infra' },
    ],
    foot: 'a browser · your IdP · zero footprint',
    loop: ['open session', 'attach pty', 'exit'],
  },
  {
    title: `codeflare · ${SPINE.pr}`,
    lines: [
      { tone: 'cmd', text: 'on pull_request → /review --deep' },
      { tone: 'agent', text: '✻ 6 reviewer agents · in parallel' },
      { tone: 'warn', text: '⚠ 2 findings · fixed in-session' },
      { tone: 'ok', text: "✓ CI green · the merge is a human's" },
    ],
    foot: 'code · security · spec · tests · docs · e2e',
    loop: ['/review --deep', 'gh pr view 207', 'merge'],
  },
  {
    title: 'codeflare · spec',
    lines: [
      { tone: 'cmd', text: `/sdd implement ${SPINE.req}` },
      { tone: 'warn', text: '⚠ AC3 not covered · blocking' },
      { tone: 'agent', text: '✻ agent corrects to the plan' },
      { tone: 'ok', text: '✓ 10 of 10 green · zero drift' },
    ],
    foot: 'spec · tests · docs, aligned and enforced',
    loop: ['/sdd status', 'run AC tests', 'check drift'],
  },
];

export const SHIFT = {
  id: 'shift',
  title: 'The bottleneck was never typing speed.',
  lead:
    'A faster autocomplete just gets you to the next decision sooner. Codeflare moves the whole ' +
    'job into one controlled run: you write the requirement, agents prepare the change, and your ' +
    'team reviews the evidence before it executes. The four below are snapshots of a governed run: ' +
    'egress, isolation, review, and spec.',
};

export const METHOD = {
  id: 'method',
  title: 'Spec, tests, and docs, enforced as one.',
  lead:
    'Every run starts from requirements with acceptance criteria. At the pull request, Codeflare ' +
    'checks the diff against that contract and sends failures back to the agent until the code, ' +
    'its tests, and the docs all agree.',
  pillars: [
    {
      title: 'Approve the intent first',
      body:
        'Before any code, a requirement and its acceptance criteria are written down. ' +
        '/sdd init bootstraps the repo into that spec-driven framework, backed by a knowledge ' +
        'graph of your code and decisions, so the agent builds against intent you already approved.',
    },
    {
      title: 'Enforcement is a loop',
      body:
        'At every PR boundary, spec and TDD enforcers check the diff against its requirements ' +
        'and reject test theater. Findings route back to the agent, which fixes and re-verifies, ' +
        'and nothing merges until the build matches the spec.',
    },
  ] satisfies Card[],
  // The self-healing loop made concrete: a drift caught at the PR boundary and
  // corrected before a human looks. Rendered as a sequenced enforcement gate
  // (proof artifact), not a flat log. This is the move neither competitor dares:
  // showing the agent fail, then the platform catch and fix it.
  gate: {
    req: SPINE.req,
    criterion: `${SPINE.ac}: duplicate payment requests stay idempotent`,
    pr: SPINE.pr,
    caption:
      'Drift is a blocking finding: caught, corrected, and re-verified before a human ever looks.',
    steps: [
      { actor: 'spec-enforce', state: 'fail', text: 'AC3 is not covered by a test' },
      { actor: 'tdd-enforce', state: 'fail', text: 'an assertion-free test is rejected as theater' },
      { actor: 'agent', state: 'work', text: 'corrects to the plan, writes the missing case' },
      { actor: 'reverify', state: 'pass', text: 'AC3 now verified, 10 of 10 green' },
      { actor: 'merge', state: 'pass', text: 'allowed, zero deviations from the spec' },
    ] satisfies GateStep[],
  },
};

/**
 * Legacy rescue: the enterprise blocker is not greenfield, it is the
 * code you already have. /sdd init reverse-engineers a legacy codebase into a
 * spec-driven baseline, and /sdd clean realigns a spec that has drifted. The
 * behavior is real (sdd-init Import/Resume modes, sdd-clean rescue); the counts
 * are illustrative, consistent with the page's other example figures.
 */
export const LEGACY = {
  id: 'legacy',
  title: 'Legacy code, reverse-engineered into a spec-driven baseline.',
  lead:
    'Point /sdd init at an existing repo and it reverse-engineers the requirements, acceptance ' +
    'criteria, and knowledge graph an agent needs to work the code without drifting. ' +
    '/sdd clean brings a drifted spec back into line.',
  terminal: {
    title: 'codeflare · /sdd init',
    lines: [
      { tone: 'cmd', text: '/sdd init --import legacy-payments' },
      { tone: 'agent', text: '✻ reading the codebase · building the knowledge graph' },
      { tone: 'agent', text: '✻ enumerating behavior → requirements with acceptance criteria' },
      { tone: 'warn', text: '⚠ 38 requirements drafted · 12 flagged for triage' },
      { tone: 'ok', text: '✓ spec baseline committed · agents can work it safely' },
      { tone: 'cmd', text: '/sdd clean' },
      { tone: 'ok', text: '✓ drifted spec realigned to the code · enforced from here' },
    ] satisfies TranscriptLine[],
    foot: 'legacy in · spec-driven baseline out',
  },
};

export const SECURITY = {
  id: 'security',
  title: 'Built on a zero-trust foundation.',
  lead:
    'Every dangerous path is closed at the architecture level. A session authenticates through ' +
    'your IdP, runs in an isolated container in your tenancy, and reaches models only through ' +
    'your AI Gateway.',
  microCta: 'Request the security architecture briefing',
  // The boundary as one proof artifact: the approved paths (pass) and the paths
  // the architecture makes impossible (deny), in the same gate grammar as the
  // enforcement gate and egress strip, so security reads as one coherent receipt.
  boundary: {
    title: 'boundary · one session',
    rows: [
      { actor: 'identity', state: 'pass', label: 'authenticated', text: 'your IdP · Entra, Okta, any OIDC' },
      { actor: 'container', state: 'pass', label: 'isolated', text: 'your tenancy · destroyed on exit' },
      { actor: 'transport', state: 'pass', label: 'post-quantum', text: 'every session keyed post-quantum · X25519MLKEM768' },
      { actor: 'egress', state: 'pass', label: 'inspected', text: 'your AI Gateway · guardrails · DLP' },
      { actor: 'direct call', state: 'deny', label: 'denied', text: 'no provider endpoint outside the gateway' },
      { actor: 'lateral move', state: 'deny', label: 'impossible', text: 'nothing to escalate into, nowhere to go' },
      { actor: 'exfiltration', state: 'deny', label: 'none', text: 'source never touches the endpoint device' },
    ] satisfies BoundaryRow[],
    // The boundary and one real call through it now read as one receipt: a
    // left-aligned command echo (EGRESS.call) above a thin divider issues the
    // call, the egress rows inspect it below, and the merged caption closes the
    // single terminal (see #7 in the round-2 owner feedback).
    caption: 'The boundary is yours, sessions post-quantum secured, and nothing leaves it unseen.',
  },
};

/** Egress-inspection strip: one outbound model call inspected at the boundary,
 *  turning DLP and guardrails into auditable evidence rather than asserted
 *  claims. Structural twin of the enforcement gate; the DLP redaction is the
 *  one amber beat. */
export const EGRESS = {
  call: 'POST /v1/chat/completions',
  rows: [
    { actor: 'guardrails', state: 'pass', label: 'passed', text: 'prompt and tool calls within policy' },
    {
      actor: 'DLP',
      state: 'redact',
      label: 'redacted',
      text: '1 cardholder PAN masked before the request leaves the boundary',
    },
    { actor: 'route', state: 'pass', label: 'approved', text: 'sent to an approved model, every token attributed' },
  ] satisfies EgressRow[],
  caption: 'No model call leaves the boundary without inspection and an owner.',
};

/** A row in the MCP-portal artifact (the tool-governance proof terminal). Same
 *  gate grammar as the security boundary so it reads as one more receipt; the
 *  code-mode row uses `work` for a cyan accent that draws the eye. */
export interface McpRow {
  actor: string;
  state: 'pass' | 'work';
  label: string;
  text: string;
}

/**
 * MCP portals: the external tools an agent can reach, governed. Many MCP servers
 * collapse behind one portal endpoint; every call is made as the signed-in user
 * with least privilege and is attributed; and code mode collapses the whole tool
 * surface into a single typed `code` tool the agent drives in an isolated worker.
 * Rendered as a dynamic proof terminal (rolling governance rows in the gate
 * grammar), the page's terminal idiom, not prose.
 */
export const MCP = {
  id: 'mcp',
  title: 'Every tool call, attributed to a known identity.',
  lead:
    'An agent is only as safe as the tools it can reach. Codeflare routes every MCP server ' +
    'through one portal where each call runs as the signed-in user, scoped to least privilege ' +
    'and logged by name. Code mode folds the surface into one typed `code` tool in a sandbox.',
  portal: {
    title: 'mcp portal · one endpoint',
    rows: [
      { actor: 'portal', state: 'pass', label: 'unified', text: 'internal and SaaS MCP servers on one endpoint' },
      { actor: 'identity', state: 'pass', label: 'as the user', text: 'the agent authenticates as you, scoped to least privilege' },
      { actor: 'policy', state: 'pass', label: 'scoped', text: 'each group sees only the tools it is entitled to' },
      { actor: 'code mode', state: 'work', label: '40 → 1', text: 'the whole tool surface becomes one typed `code` tool' },
      { actor: 'sandbox', state: 'pass', label: 'isolated', text: 'agent-written code runs in a throwaway worker' },
      { actor: 'audit', state: 'pass', label: 'attributed', text: 'every tool call logged to your tenancy, by name' },
    ] satisfies McpRow[],
    caption: 'One portal · least privilege · every call attributed',
  },
};

export const GITHUB_URL = 'https://github.com/nikolanovoselec/codeflare';

/** Dogfooding proof: this very page is REQ-LANDING-001, built by Codeflare under
 *  its own spec / test / review enforcement. The @impl and @test anchors are
 *  real (they live in sdd/spec/landing.md) and load-bearing in the pipeline, so
 *  this is the most credible artifact on the page: it is literally true. */
export const DOGFOOD = {
  id: 'dogfood',
  title: 'Codeflare built this page.',
  lead:
    'The page you are reading is REQ-LANDING-001 in the Codeflare spec. It shipped through the ' +
    'same spec, test, and review gates described above, and every anchor below points at the real file.',
  terminalTitle: 'REQ-LANDING-001 · sdd/spec/landing.md',
  lines: [
    { tone: 'cmd', text: 'sdd status REQ-LANDING-001' },
    { tone: 'ok', text: '✓ Status: Implemented' },
    { tone: 'dim', text: '@impl landing/src/pages/index.astro' },
    { tone: 'dim', text: '@impl landing/src/components/Hero.astro' },
    { tone: 'dim', text: '@impl landing/src/components/FeatureTerminals.astro' },
    { tone: 'dim', text: '@impl landing/src/content/site.ts' },
    { tone: 'dim', text: '@test landing/src/__tests__/index-page.test.ts' },
    { tone: 'ok', text: '✓ shipped via PR #533 · reviewed at the boundary · CI green' },
  ] satisfies TranscriptLine[],
  foot: 'real anchors · enforced at every PR boundary',
  cta: { label: 'See it on GitHub', href: GITHUB_URL },
};

export const OPERATIONS = {
  id: 'operations',
  // Nested terminal-path tag: one level under the security section's own "~/security",
  // so the path depth marks this as a sub-section (the "~/" prefix is added in CSS).
  tag: 'security/operations',
  title: 'The same agents operate your infrastructure.',
  lead:
    'The same session model works past the repo. Agents reach approved infrastructure through ' +
    'zero-trust tunnels to run scoped commands, apply patches, handle migrations, and drive ' +
    'incident response, with an audit trail behind every action.',
  cards: [
    {
      title: 'Policy-scoped zero-trust tunnels',
      body:
        'Internal hosts, databases, and control planes sit behind zero-trust access policy. ' +
        'A session gets only the routes its group is allowed, never the flat network. No broad ' +
        'VPN grant, and no credential living in the container.',
    },
    {
      title: 'Logged to your tenancy',
      body:
        'Every connection and command flows through the same attributed path as model traffic, ' +
        'written to your logs in your tenancy: who reached what, when, and under which policy.',
    },
  ] satisfies Card[],
};

export const BROWSER = {
  id: 'browser',
  tag: 'platform/runs-everywhere',
  title: 'No client to install. Just a browser.',
  lead:
    'Codeflare runs in your own estate. The laptop or phone in front of an engineer is only a window ' +
    'onto the session, with no local toolchain to install, patch, or wipe.',
  cards: [
    {
      title: 'Ready in seconds',
      body:
        'A full Linux environment with every supported agent preinstalled boots in seconds. ' +
        'No golden images to maintain, no workstation build, no local toolchain to patch.',
    },
    {
      title: 'Access starts in your IdP',
      body:
        'Add an engineer to the right group in your identity provider and they are productive ' +
        'on day one. Remove the membership and access is gone the same day, with no device to ' +
        'reclaim or wipe.',
    },
    {
      title: 'Check in from anywhere',
      body:
        'Long-running sessions keep working whether you watch or not. Review findings, redirect ' +
        'an agent, or approve the next step from whatever device you have on you.',
    },
  ] satisfies Card[],
};

export const PLATFORM = {
  id: 'platform',
  title: 'Your context, guidelines, and best practices, preloaded.',
  lead:
    'A session starts knowing your conventions, your codebase, and your past decisions, not as ' +
    'a blank slate. Skills load on demand and specialist reviewers stand ready, the same way ' +
    'for every supported agent.',
  // The "arrives equipped" proof, shown the way the rest of the page trades: a
  // session boot log. Each capability is loaded before the first prompt and rolls
  // in as a checklist (data-roll) in the terminal idiom, so this section carries a
  // live artifact like every other one instead of a wall of prose cards.
  seed: {
    title: 'codeflare · session',
    meta: 'cold start → equipped',
    rows: [
      { actor: 'scaffolding', label: 'attached', text: 'your standards, patterns, and history' },
      { actor: 'skills', label: '30+', text: 'spec-driven dev · CI · deploy · security, loaded on demand' },
      { actor: 'subagents', label: '11', text: 'architect · reviewer · security · TDD guide, delegated in parallel' },
      { actor: 'memory', label: 'graph', text: 'repos · docs · decisions, queryable, so prior calls still hold' },
      { actor: 'any agent', label: 'one engine', text: 'identical governance whichever agent does the work' },
    ],
    caption: 'every session · same context · same controls · same isolation',
  },
};

export const CONTEXT = {
  id: 'context',
  title: 'The web, the way an agent reads it.',
  lead:
    "Heavy pages are mostly chrome an agent can't use. Codeflare loads each one in an isolated, " +
    'ephemeral browser, runs the scripts, resolves the gate, and returns clean markdown, turning ' +
    'a 1.9 MB page into 12 kB worth reading.',
  // One real fetch from the spine run shown as a proof terminal: the open web
  // crosses an isolation boundary the remote page never breaches, then resolves
  // to agent-ready markdown. The headline beat is the context-economics win: a
  // heavy page reduced to a fraction an agent can read without drowning.
  terminal: {
    title: 'codeflare · web',
    lines: [
      { tone: 'cmd', text: 'agent → docs.vendor.com/idempotency-keys' },
      { tone: 'agent', text: '✻ throwaway browser · JS runs · gate resolved' },
      { tone: 'deny', text: '✕ scripts · trackers · page chrome · never cross' },
      { tone: 'ok', text: '✓ 1.9 MB page → 12 kB clean markdown' },
      { tone: 'ok', text: '✓ into the graph · context spent on the work' },
    ] satisfies TranscriptLine[],
    foot: 'throwaway per fetch · never your network · never the container',
  },
  // The OTHER Browser Run surface: the same throwaway browser the agent reads
  // with, it also DRIVES. An agent-steered semantic e2e at a mobile viewport,
  // judging the deployed app against intent (the deny line is a real clip this
  // repo's own landing QA caught and filed). Shown beside the web-fetch terminal as a paired proof.
  e2e: {
    tag: 'context/automation',
    heading: 'From reading pages to driving them.',
    lead:
      'Hand an agent a deployed flow and a mobile viewport, and the same isolated browser runs ' +
      'the end-to-end test: it navigates, taps, captures each screen, and judges the result ' +
      'against the acceptance criteria.',
    terminal: {
      title: 'codeflare · e2e',
      lines: [
        { tone: 'cmd', text: 'agent → e2e codeflare.ch/login · from mobile' },
        { tone: 'agent', text: '✻ throwaway browser · 390x844 viewport' },
        { tone: 'agent', text: '✻ navigate · screenshot · tap "Continue with GitHub"' },
        { tone: 'ok', text: '✓ AC1 · OAuth reached, the flow is seamless' },
        { tone: 'deny', text: '✕ AC2 · foot caption clips at 390px · fix filed' },
      ] satisfies TranscriptLine[],
      foot: 'the agent drives and judges the page, not a brittle selector',
    },
  },
};

export const PIPELINE = {
  id: 'pipeline',
  title: 'Agents work inside your pipeline, not around it.',
  lead:
    'There is no shadow toolchain. Every agent change moves through your git, your CI, and your ' +
    'branch protections, then a panel of specialist reviewers, before a human approves the merge.',
  // The PR-boundary review as a board: six specialist agents reviewing one diff
  // in parallel, two of them catching and re-proving a finding, all converging
  // on a single human triage gate. Makes "one engineer, many agents" literal.
  trigger: 'on pull_request → /review --deep',
  dispatch: `${SPINE.pr} · 6 lanes dispatched · 1 human gate`,
  lanes: [
    { agent: 'code-reviewer', result: 'finding', note: '2 findings, both fixed in-session' },
    { agent: 'security-reviewer', result: 'clean', note: 'no injection, no secret exposure' },
    { agent: 'spec-reviewer', result: 'clean', note: 'REQ-PAY-014 acceptance criteria verified' },
    { agent: 'tdd-enforce', result: 'finding', note: 'test theater rejected, then re-proven' },
    { agent: 'doc-updater', result: 'clean', note: 'api-reference.md updated in the same commit' },
    { agent: 'deep-reviewer', result: 'clean', note: 'behavior matches the spec, end to end' },
  ] satisfies ReviewLane[],
  verdict: {
    title: 'PR #207 ready for human triage',
    note: 'CI green · the full review trail attached.',
  },
};

/** A live agent in the orchestration tree (its own section's proof artifact):
 *  the real "● Running N agents…" operator view of the PR-boundary review, with
 *  per-agent tool-use and token counters and a current-activity sub-line. The
 *  counters and activity tick live in the browser (orch.ts); the values here are
 *  the resolved no-JS state and the starting point for the animation. activities
 *  are ordinary agent commands, the way an operator would see them scroll. */
export interface AgentRun {
  agent: string;
  task: string;
  toolUses: number;
  tokens: number; // thousands of tokens; rendered as `${tokens.toFixed(1)}k`
  activities: string[]; // activities[0] is the resolved/no-JS line; orch.ts cycles the rest
}

/**
 * The orchestration view: the same parallel review as the board, shown the way
 * the operator watches it run, three report-only reviewers on one diff at once,
 * each with its own tool-use / token counters and current activity, plus the
 * real keyboard affordances. Its own section now, and live: orch.ts ticks
 * the counters and advances each agent's activity so it reads as a running feed
 * instead of a frozen screenshot.
 */
export const ORCHESTRATION = {
  id: 'orchestration',
  title: 'Watch every agent work in real time.',
  lead:
    "This is the operator's view of the same review: three reviewers on one diff at once, each " +
    "showing what it's doing and spending as it goes. Follow any one closely, or send the run " +
    'to the background and move on to the next task.',
  header: 'Running 3 agents',
  hint: 'ctrl+o to expand',
  agents: [
    {
      agent: 'code-reviewer',
      task: 'Code review · round 2 + tests',
      toolUses: 13,
      tokens: 45.0,
      activities: [
        'Reading src/payments/idempotency.ts',
        'grep -rn "Idempotency-Key" src/',
        'Running 12 tests…',
        'Writing 2 findings',
      ],
    },
    {
      agent: 'spec-reviewer',
      task: 'Spec review · round-2 delta',
      toolUses: 2,
      tokens: 36.6,
      activities: [
        'Reading sdd/spec/payments.md',
        'Checking AC3 acceptance criteria',
        'Verifying REQ-PAY-014 coverage',
      ],
    },
    {
      agent: 'doc-updater',
      task: 'Doc review · round-2 delta',
      toolUses: 4,
      tokens: 34.2,
      activities: [
        'Reading documentation/api-reference.md',
        'Editing api-reference.md',
        'Checking REQ backlinks',
      ],
    },
  ] satisfies AgentRun[],
  footHint: 'ctrl+b to run in background',
  foot: 'three reviewers · one diff · in parallel',
};

export const COST = {
  id: 'cost',
  title: 'Every spend has a known actor.',
  lead:
    'Codeflare records cost where it is created: container time, browser work, tool calls, and ' +
    'model tokens. Each line rolls up to a user, team, agent, and route in your own estate.',
  // The attribution claim made concrete: an audited ledger where every line
  // carries an owner, and the last total reads zero unattributed.
  ledger: {
    // Bound to the spine run so the ledger reads as the literal bill for PR #207,
    // not a generic table. The rows are a representative sample; the totals cover
    // the whole run, so the sample note reconciles the two (the visible rows sum
    // to less than the totals by design).
    meta: `${SPINE.pr} · ${SPINE.user} · ${SPINE.team}`,
    sample: 'showing 4 of 41 model calls · totals cover the full run',
    columns: ['time', 'user', 'team', 'agent', 'route', 'cost'],
    rows: [
      { time: '09:41:03', user: 't.anderson', team: 'payments', agent: 'spec-enforce', route: 'gateway / openai', cost: '$0.08' },
      { time: '09:41:11', user: 't.anderson', team: 'payments', agent: 'code-reviewer', route: 'gateway / anthropic', cost: '$0.21' },
      { time: '09:41:19', user: 't.anderson', team: 'payments', agent: 'container', route: 'edge-container', cost: '$0.03' },
      { time: '09:41:25', user: 't.anderson', team: 'payments', agent: 'browser-fetch', route: 'isolated-render', cost: '$0.01' },
    ] satisfies LedgerRow[],
    totals: [
      { label: 'environment', value: '$0.34' },
      { label: 'inference', value: '$2.81' },
      { label: 'agent tools', value: '$0.46' },
      { label: 'unattributed', value: '$0.00', accent: true },
    ] satisfies LedgerTotal[],
  },
  cards: [
    {
      title: 'Environment',
      body:
        'Containers run in your tenancy, exist only while a session is active, and hibernate to ' +
        'zero when idle. The spend lands in your own estate as line items, not in a vendor black box.',
    },
    {
      title: 'Inference',
      body:
        'Model traffic runs through your AI Gateway. Spend is visible by user, team, and group; ' +
        'each group is pinned to its approved models; and traffic fails over automatically when a ' +
        'provider degrades.',
    },
    {
      title: 'Agent tools',
      body:
        'Because interception runs below the container, no CLI tool can slip past it. Every token ' +
        'an agent burns lands in the same attributed stream as the rest.',
    },
  ] satisfies Card[],
};

export const TENANCY = {
  id: 'tenancy',
  tag: 'cost/tenancy',
  title: 'Deployed in your own estate.',
  lead:
    'Codeflare deploys into <strong>your own estate</strong>, with no vendor in the ' +
    'data path. Source, sessions, and model traffic stay inside your trust boundary, and a ' +
    'guided setup takes a fresh account to a running engine.',
};

export const FAQ_SECTION = {
  id: 'faq',
  title: 'The answers, up front.',
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: 'Where does our code and data live?',
    answer:
      'Inside your own estate. Workspace storage uses your object-storage buckets, metadata ' +
      'your key-value store, and sessions run in containers under your tenancy. Codeflare is software ' +
      'you operate, so we never hold your code. Storage is encrypted at rest, with customer-provided key options.',
  },
  {
    question: 'How do agents reach LLM providers?',
    answer:
      'Not directly. All model traffic is intercepted at the platform layer and routed through ' +
      'your AI Gateway with your keys, where guardrails and DLP apply. You pick approved models per ' +
      'group, set rate limits, and see attributed spend. Provider outages fail over automatically, ' +
      'and provider credentials never enter the container.',
  },
  {
    question: 'How does authentication work with our IdP?',
    answer:
      'Through zero-trust access in front of every surface, federating to Entra ID, Okta, Google ' +
      'Workspace, or any SAML/OIDC provider you already run. Provisioning is group membership; offboarding is group removal.',
  },
  {
    question: 'What stops an agent from escalating privileges?',
    answer:
      'Hard infrastructure boundaries. Each session runs in its own ephemeral container behind ' +
      'zero-trust access, with no peers to move to and no standing infrastructure to persist on. ' +
      'When the session ends, the container is destroyed.',
  },
  {
    question: 'Which agents are supported?',
    answer:
      'Claude Code, OpenAI Codex, GitHub Copilot, Pi, Google Antigravity, and OpenCode, ' +
      'selectable per session with the same isolation and governance regardless of choice.',
  },
  {
    question: 'What does it cost to run?',
    answer:
      'Pay-per-use on your own bill: container minutes while sessions run, storage ' +
      'per byte, and your negotiated model rates through the AI Gateway. No per-seat licenses, no ' +
      'idle fleet, and no vendor margin on your inference.',
  },
  {
    question: 'Does this replace our existing SDLC tooling?',
    answer:
      'It works through your existing tooling rather than replacing it. Agents commit through your ' +
      'git, run your CI, and obey your branch protections; the review pipeline layers extra gates ' +
      'on top and removes none of yours.',
  },
];

/** A logo in the social-proof strip. */
export interface TrustedLogo {
  src: string;
  alt: string;
  name: string;
  href: string;
}

/** Social proof: a calm logo strip just before the contact CTA. The eyebrow is
 *  deliberately relationship-neutral ("In good company") so each mark reads as
 *  association rather than a stated customer or vendor claim. Logos are ordered
 *  alphabetically by name; assets ship from the landing public root and each
 *  links to the brand site. */
export const TRUSTED = {
  label: 'In good company',
  logos: [
    { src: '/landing/customers/cloudflare.svg', alt: 'Cloudflare', name: 'Cloudflare', href: 'https://www.cloudflare.com' },
    { src: '/landing/customers/graymatter.svg', alt: 'Gray Matter', name: 'Gray Matter', href: 'https://graymatter.ch' },
    { src: '/landing/customers/swiss-post.svg', alt: 'Swiss Post', name: 'Swiss Post', href: 'https://www.post.ch' },
    { src: '/landing/customers/ztsolutions.png', alt: 'ZT Solutions', name: 'ZT Solutions', href: 'https://ztsolutions.io' },
  ] satisfies TrustedLogo[],
};

const TOPIC_LABELS: Record<ContactTopic, string> = {
  'enterprise-deployment': 'Enterprise deployment',
  'pilot-poc': 'Pilot / proof of concept',
  'security-compliance': 'Security & compliance review',
  partnership: 'Partnership',
  general: 'General inquiry',
};

export const CONTACT_FORM = {
  id: 'contact',
  title: 'Deploy Codeflare in your environment.',
  aside: [
    "New to engineering agents, scoping a pilot, or reviewing the security model? Tell us about " +
      "your environment and we'll take it from there.",
    'Your message goes directly to the team that builds Codeflare. Expect a reply within 1 to 2 ' +
      'business days. Submissions are protected against bots and are not stored. ' +
      'Your data is never sold or shared.',
  ],
  topics: CONTACT_TOPICS.map((value) => ({ value, label: TOPIC_LABELS[value] })) satisfies TopicOption[],
};

/** An enterprise SSO provider button. The buttons look real but are CTAs: the
 *  product offers GitHub sign-in today; enterprise SSO is a sales conversation,
 *  so tapping one expands a "get in touch" panel rather than starting an OIDC
 *  flow. `id` drives the monogram chip and a stable data attribute for tests. */
export interface SsoProvider {
  id: string;
  name: string;
}

/**
 * The onboarding-mode sign-in page (landing/src/pages/login.astro), served at
 * /login when the deployment runs in onboarding mode. Same design system as the
 * marketing landing (tokens, fonts, splash) so the two flow into one another.
 * Everyone enters via GitHub: an approved account goes straight to the app, a
 * new visitor is told their access request was submitted and is emailed a
 * confirmation. Enterprise SSO is shown as expand-to-CTA buttons that deep-link
 * to the contact form. No em/en dashes in any rendered copy.
 */
export const LOGIN = {
  title: 'Sign in to Codeflare',
  sub: 'Engineering agents, running in your own estate, under your control.',
  github: { label: 'Continue with GitHub', href: '/auth/github/login' },
  ssoHeading: 'Enterprise SSO',
  ssoProviders: [
    { id: 'entra', name: 'Microsoft Entra ID' },
    { id: 'okta', name: 'Okta' },
    { id: 'ping', name: 'Ping Identity' },
    { id: 'google', name: 'Google Workspace' },
  ] satisfies SsoProvider[],
  sso: {
    body:
      "comes with Codeflare Enterprise, set up when it's deployed into your own estate " +
      'alongside your identity provider and access policies. That is why it starts with a conversation.',
    cta: { label: 'Get in touch', href: '/landing/?topic=enterprise-deployment#contact' },
  },
  helper:
    "New here? Continue with GitHub to request access. " +
    "We'll email you when your workspace is approved.",
  // The post-OAuth "access request submitted" state (login.astro reads ?status=requested).
  requested: {
    title: "You're on the list",
    body:
      "We've sent a confirmation to your inbox. You'll hear from us as soon as " +
      'your workspace is approved.',
  },
  back: { label: 'Back to codeflare.ch', href: '/landing/' },
  // OAuth-flow error copy, keyed by the ?error=<code> the Worker redirects with.
  // Hyphen codes are Worker-emitted; underscore codes pass through from GitHub.
  errors: {
    'session-expired': 'Your sign-in took too long. Please try again.',
    'no-verified-email':
      'Your GitHub account has no verified primary email. Verify it on GitHub and try again.',
    access_denied: 'Sign-in was cancelled.',
    redirect_uri_mismatch: 'Sign-in configuration error. Please contact support.',
    application_suspended: 'The sign-in app is suspended. Please contact support.',
    default: 'Sign-in failed. Please try again.',
  } as Record<string, string>,
};

