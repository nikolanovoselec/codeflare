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

export const NAV_LINKS: NavLink[] = [
  { label: 'The shift', href: '#shift' },
  { label: 'Method', href: '#method' },
  { label: 'Security', href: '#security' },
  { label: 'Pipeline', href: '#pipeline' },
  { label: 'Cost', href: '#cost' },
];

export const AGENTS = ['claude-code', 'codex', 'copilot', 'pi', 'antigravity', 'opencode'];

export const HERO = {
  kicker: 'The enterprise agentic coding engine',
  headline: { plain: 'This is not', flare: 'a coding assistant.' },
  sub:
    'Autonomous agents that build, review, test, and ship inside your enterprise boundary. ' +
    'Spec, tests and docs stay aligned at every pull request. ' +
    'One engineer, the output of a team.',
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
  user: 'a.chen',
  team: 'payments',
  service: 'payments-service',
};

export const TERMINAL = {
  title: `codeflare · ${SPINE.service}`,
  lines: [
    { tone: 'cmd', text: `/sdd implement ${SPINE.req}` },
    { tone: 'agent', text: '✻ ephemeral container · your tenancy' },
    { tone: 'agent', text: '✻ tests first, then the code' },
    { tone: 'warn', text: '⚠ drift is a blocking finding' },
    { tone: 'agent', text: '✻ agent corrects · re-verified 10/10' },
    { tone: 'cmd', text: '/review --deep · 6 agents' },
    { tone: 'deny', text: '✕ direct provider call denied' },
    { tone: 'dim', text: '  → your AI Gateway · DLP on egress' },
    { tone: 'ok', text: '✓ specification, implementation and documentation aligned' },
    { tone: 'ok', text: `✓ ${SPINE.pr} ready · CI green · you merge` },
  ] satisfies TranscriptLine[],
  foot: {
    ctx: 'context 18%',
    model: 'opus-4.8',
    reason: 'reasoning high',
    note: SPINE.service,
  } satisfies TerminalFoot,
  // The hero prompt types one coherent run of the spine PR and rests on the
  // merge (data-ft-once in Hero.astro: type, hold, advance, stop). The hero
  // reads as a single engineer taking REQ-PAY-014 from intent to merge, not a
  // looping capability reel. Reduced motion / no JS: the first beat is shown.
  run: [
    '/sdd implement REQ-PAY-014',
    'tests first → 10 of 10 green',
    'drift caught → agent corrects',
    '/review --deep · 6 agents · clean',
    'gh pr merge 207 → main',
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
  station: { n: '01', label: 'shift' },
  title: 'Decades of SDLC. One generational leap.',
  lead:
    'Coding assistants made typing faster. Codeflare changes what an engineer <em>is</em>: ' +
    'the engineer specifies, steers, and judges; agents do everything else. ' +
    'Four moments from inside the boundary.',
};

export const METHOD = {
  id: 'method',
  station: { n: '02', label: 'spec' },
  title: 'Spec-driven development, enforced.',
  lead:
    'Codeflare does not just let agents write code. Every change is governed by a ' +
    'specification and proven by tests, with enforcement that leaves the agent no room ' +
    'to drift from the plan.',
  pillars: [
    {
      title: 'The plan is a spec',
      body:
        'Work begins as requirements with acceptance criteria, not a loose prompt. ' +
        '/sdd init bootstraps a repository into a spec-driven framework, grounded in a ' +
        'knowledge graph of your code, decisions, and docs. You approve the intent before a line is written.',
    },
    {
      title: 'Enforcement is a loop',
      body:
        'At every PR boundary the spec and TDD enforcers check the diff against its ' +
        'requirements and reject test theater. Findings route straight back to the agent, ' +
        'which corrects and re-verifies; nothing merges until what was built matches what was specified.',
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
 * Legacy-rescue station: the enterprise blocker is not greenfield, it is the
 * code you already have. /sdd init reverse-engineers a legacy codebase into a
 * spec-driven baseline, and /sdd clean realigns a spec that has drifted. The
 * behavior is real (sdd-init Import/Resume modes, sdd-clean rescue); the counts
 * are illustrative, consistent with the page's other example figures.
 */
export const LEGACY = {
  id: 'legacy',
  station: { n: '03', label: 'rescue' },
  title: 'Legacy code, made safe for agents.',
  lead:
    'Autonomy is easy on greenfield; the hard part is the code you already have. ' +
    '/sdd init reverse-engineers a legacy codebase into a spec-driven baseline (requirements, ' +
    'acceptance criteria, a knowledge graph) so agents can work it autonomously without drifting. ' +
    '/sdd clean brings a spec that has drifted back into alignment.',
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
  station: { n: '04', label: 'boundary' },
  title: 'Zero trust is the architecture, not just a policy.',
  lead:
    'Autonomous agents are only safe inside structural boundaries. Codeflare makes the ' +
    'dangerous paths impossible to express, not merely discouraged: one session, ' +
    'everything it may do, and everything it cannot.',
  microCta: 'Request the security and compliance deep-dive',
  // The boundary as one proof artifact: the approved paths (pass) and the paths
  // the architecture makes impossible (deny), in the same gate grammar as the
  // enforcement gate and egress strip, so security reads as one coherent receipt.
  boundary: {
    title: 'boundary · one session',
    rows: [
      { actor: 'identity', state: 'pass', label: 'authenticated', text: 'your IdP · Entra, Okta, any OIDC' },
      { actor: 'container', state: 'pass', label: 'isolated', text: 'your tenancy · destroyed on exit' },
      { actor: 'egress', state: 'pass', label: 'inspected', text: 'your AI Gateway · guardrails · DLP' },
      { actor: 'direct call', state: 'deny', label: 'denied', text: 'no provider endpoint outside the gateway' },
      { actor: 'lateral move', state: 'deny', label: 'impossible', text: 'nothing to escalate into, nowhere to go' },
      { actor: 'exfiltration', state: 'deny', label: 'none', text: 'source never touches the endpoint device' },
    ] satisfies BoundaryRow[],
    // The boundary and one real call through it now read as one receipt: the
    // egress rows render below a thin divider inside this same terminal, and the
    // merged caption closes the single terminal (see #7 in the round-2 owner
    // feedback). The sub-label is rendered from EGRESS.call in the template.
    caption: 'The boundary is yours, and nothing leaves it unseen.',
  },
};

/** Egress-inspection strip: one outbound model call inspected at the boundary,
 *  turning DLP and guardrails into auditable evidence rather than asserted
 *  claims. Structural twin of the enforcement gate; the DLP redaction is the
 *  one amber beat. */
export const EGRESS = {
  call: `${SPINE.pr} · POST /v1/chat/completions → gateway`,
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
  caption: 'Nothing leaves the boundary unseen.',
};

export const GITHUB_URL = 'https://github.com/nikolanovoselec/codeflare';

/** Dogfooding proof: this very page is REQ-LANDING-001, built by Codeflare under
 *  its own spec / test / review enforcement. The @impl and @test anchors are
 *  real (they live in sdd/spec/landing.md) and load-bearing in the pipeline, so
 *  this is the most credible artifact on the page: it is literally true. */
export const DOGFOOD = {
  id: 'dogfood',
  station: { n: '11', label: 'proof' },
  title: 'Codeflare built this page.',
  lead:
    'This landing page is REQ-LANDING-001 in the Codeflare specification, built and shipped by ' +
    'Codeflare under the same enforcement shown above. Every anchor below is real.',
  terminalTitle: 'REQ-LANDING-001 · sdd/spec/landing.md',
  lines: [
    { tone: 'cmd', text: 'sdd status REQ-LANDING-001' },
    { tone: 'ok', text: '✓ Status: Implemented' },
    { tone: 'dim', text: '@impl landing/src/pages/index.astro' },
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
  title: 'Not just code. The systems behind it.',
  lead:
    'The same governed agents that ship code can operate the infrastructure it runs on: ' +
    'orchestrate environments, patch fleets, carry migrations through, drive incident response.',
  cards: [
    {
      title: 'Policy-scoped zero-trust tunnels',
      body:
        'Agents reach internal hosts, databases, and control planes through tunnels gated by ' +
        'Cloudflare Access policy. A session sees only what its group is entitled to, never the ' +
        'flat network: no standing VPN to over-grant, no credentials living in the container.',
    },
    {
      title: 'Every action attributed',
      body:
        'Each connection and command flows through the same audited, attributed path as model ' +
        'traffic. Who reached what, when, and under which policy is written to your logs, in your ' +
        'tenancy. No unsigned access, no shadow operations.',
    },
  ] satisfies Card[],
};

export const BROWSER = {
  id: 'browser',
  title: 'It runs in a browser. So it runs everywhere.',
  lead:
    'The engine already runs in your cloud; a session is just a URL. The endpoint device ' +
    'becomes a window, not an asset to manage.',
  cards: [
    {
      title: 'Nothing to deploy',
      body:
        'No golden images, no workstation builds, no local toolchains to patch. Full Linux ' +
        'environments with every agent pre-installed, born in seconds.',
    },
    {
      title: 'Onboarding is IAM configuration',
      body:
        'Add a user to the Access group in your identity provider. Day-one productivity for ' +
        'hires, same-day offboarding with nothing to reclaim or wipe.',
    },
    {
      title: 'Steer from any device',
      body:
        'Autonomous sessions keep working whether you watch or not. Review findings and ' +
        'redirect agents from a laptop, a tablet, or a phone.',
    },
  ] satisfies Card[],
};

export const PLATFORM = {
  id: 'platform',
  station: { n: '09', label: 'platform' },
  title: 'Agents arrive equipped, not naive.',
  lead:
    'Every session is seeded with enterprise scaffolding the moment it starts, so agents ' +
    'already know your standards, your patterns, and your history.',
  cards: [
    {
      title: 'Any agent, one engine',
      body:
        'Claude Code, Codex, Copilot, Pi, Antigravity, OpenCode. The governance, scaffolding, ' +
        'and isolation are identical regardless of which agent does the work.',
    },
    {
      title: '30+ skills on demand',
      body:
        'Spec-driven development, CI monitoring, deployment patterns, security checklists: ' +
        'operational knowledge agents load when needed instead of rediscovering.',
    },
    {
      title: '11 specialist subagents',
      body:
        'Architect, code reviewer, security reviewer, spec enforcer, TDD guide and more: ' +
        'autonomous specialists the lead agent delegates to, in parallel.',
    },
    {
      title: 'Knowledge-graph memory',
      body:
        'Repositories, documents, and decisions ingested into a queryable graph, so agents ' +
        'recall last quarter’s architecture decision instead of contradicting it.',
    },
  ] satisfies Card[],
};

export const CONTEXT = {
  id: 'context',
  station: { n: '05', label: 'web' },
  title: 'The open web, distilled.',
  lead:
    'Agents read the open web the way a person would, through a throwaway isolated browser: the ' +
    'JavaScript runs, the login gate resolves, and a heavy page comes back as clean structured ' +
    'markdown. A 1.9 MB page becomes 12 kB an agent can actually read, so its context goes to your ' +
    'work, not the markup.',
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
};

export const PIPELINE = {
  id: 'pipeline',
  station: { n: '06', label: 'review' },
  title: 'Agents become citizens of your pipeline.',
  lead:
    'No shadow toolchain. Agents work through your git, your CI, and your branch protections, ' +
    'subject to the same gates as your engineers. Humans own intent and the merge.',
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

/** A live agent in the orchestration tree (its own station's proof artifact):
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
 * real keyboard affordances. Its own station now (07), and live: orch.ts ticks
 * the counters and advances each agent's activity so it reads as a running feed
 * instead of a frozen screenshot.
 */
export const ORCHESTRATION = {
  id: 'orchestration',
  station: { n: '07', label: 'agents' },
  title: 'Watch the work, not the weeds.',
  lead:
    'The same review, the way the operator watches it run: three reviewers on one diff at once, ' +
    'each with its own tool-use and token counters ticking as they work. Expand any agent to read ' +
    'along, or send the run to the background and get pinged when it lands.',
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
  station: { n: '08', label: 'spend' },
  title: 'No unattributed spend.',
  lead:
    'From the infrastructure minute to the inference token to what each agent consumes, ' +
    'visibility and control at every layer, in your own cloud account.',
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
      { time: '09:41:03', user: 'a.chen', team: 'payments', agent: 'spec-enforce', route: 'gateway / openai', cost: '$0.08' },
      { time: '09:41:11', user: 'a.chen', team: 'payments', agent: 'code-reviewer', route: 'gateway / anthropic', cost: '$0.21' },
      { time: '09:41:19', user: 'a.chen', team: 'payments', agent: 'container', route: 'cf-containers', cost: '$0.03' },
      { time: '09:41:25', user: 'a.chen', team: 'payments', agent: 'browser-fetch', route: 'isolated-render', cost: '$0.01' },
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
        'Serverless pay-per-use in your tenancy: containers exist only while sessions run, ' +
        'hibernate to zero when idle, and land in your cloud account as line items.',
    },
    {
      title: 'Inference',
      body:
        'Every request flows through your AI Gateway, where cost is visible per user, team, and ' +
        'department. Each group is routed to its approved models, with failover when a provider degrades.',
    },
    {
      title: 'Agent tools',
      body:
        'Interception sits below the container, so CLI tools cannot bypass it. Every token any ' +
        'agent consumes joins the same attributed stream. No shadow AI spend.',
    },
  ] satisfies Card[],
};

export const TENANCY = {
  id: 'tenancy',
  title: 'Runs where your data lives.',
  lead:
    'Codeflare deploys into <strong>your own Cloudflare account</strong>, with no vendor in the ' +
    'data path. A guided wizard takes a fresh account to a running engine.',
  manifest: [
    { label: 'Identity', note: 'your IdP' },
    { label: 'Storage', note: 'your R2, your keys' },
    { label: 'AI Gateway', note: 'guardrails, DLP, your rates' },
    { label: 'Domain', note: 'yours' },
  ],
};

export const FAQ_SECTION = {
  id: 'faq',
  station: { n: '10', label: 'answers' },
  title: 'The answers, up front.',
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: 'Where does our code and data live?',
    answer:
      'Inside your own Cloudflare account: workspace storage in your R2 buckets, metadata in ' +
      'your KV namespaces, sessions in containers under your tenancy. Codeflare is software you ' +
      'run, not a service that holds your data. Storage is encrypted at rest, with customer-provided key options.',
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
      'Through Cloudflare Access in front of every surface, federating to Entra ID, Okta, Google ' +
      'Workspace, or any SAML/OIDC provider you already run. Provisioning is group membership; offboarding is group removal.',
  },
  {
    question: 'What stops an agent from escalating privileges?',
    answer:
      'Structure, not policy. Each session runs in its own ephemeral container with no peers to ' +
      'move to and no standing infrastructure to persist on, behind zero-trust access. When the ' +
      'session ends, the container is destroyed.',
  },
  {
    question: 'Which coding agents are supported?',
    answer:
      'Claude Code, OpenAI Codex, GitHub Copilot, Pi, Google Antigravity, and OpenCode, ' +
      'selectable per session with the same isolation and governance regardless of choice.',
  },
  {
    question: 'What does it cost to run?',
    answer:
      'Pay-per-use on your own Cloudflare bill: container minutes while sessions run, storage ' +
      'per byte, and your negotiated model rates through the AI Gateway. No per-seat licenses, no ' +
      'idle fleet, and no vendor margin on your inference.',
  },
  {
    question: 'Does this replace our existing SDLC tooling?',
    answer:
      'No, it works through it. Agents use your git hosting, your CI, your deploy pipelines, and ' +
      'your branch protections. The autonomous review pipeline adds gates; it does not remove any.',
  },
];

/** Social proof: a single national-institution customer, shown as a calm
 *  "Trusted by" strip just before the contact CTA. One logo, centered; the
 *  asset ships from the landing public root. */
export const TRUSTED = {
  label: 'Trusted by',
  logo: {
    src: '/landing/customers/swiss-post.svg',
    alt: 'Swiss Post',
    name: 'Swiss Post',
  },
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
  title: 'Bring agentic coding inside your boundary.',
  aside: [
    'Whether you are evaluating agentic coding for the first time, planning a pilot, or need a ' +
      'security and compliance deep-dive, let’s talk about your environment specifically.',
    'Your message goes directly to the team that builds Codeflare. Expect a reply within 1-2 ' +
      'business days. Submissions are protected by Cloudflare Turnstile and are not stored. ' +
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
  sub: 'Autonomous coding agents, governed inside your boundary.',
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
      'Single sign-on with your identity provider is available on Codeflare Enterprise. ' +
      'Tell us which provider you run and we will set it up with you.',
    cta: { label: 'Get in touch', href: '/landing/?topic=enterprise-deployment#contact' },
  },
  helper:
    "New here? Continue with GitHub to request access. " +
    "We'll email you when your workspace is approved.",
  // The post-OAuth "access request submitted" state (login.astro reads ?status=requested).
  requested: {
    title: 'Access request submitted',
    body:
      "Thanks for your interest. We've emailed you a confirmation, and you'll hear from us " +
      'when your workspace is approved.',
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

