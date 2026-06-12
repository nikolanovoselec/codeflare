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
  tag?: string;
}

export interface CostLayer {
  name: string;
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
}

export const NAV_LINKS: NavLink[] = [
  { label: 'The shift', href: '#shift' },
  { label: 'Method', href: '#method' },
  { label: 'Security', href: '#security' },
  { label: 'Operations', href: '#operations' },
  { label: 'Pipeline', href: '#pipeline' },
  { label: 'Cost', href: '#cost' },
  { label: 'FAQ', href: '#faq' },
];

export const AGENTS = ['claude-code', 'codex', 'copilot', 'pi', 'antigravity', 'opencode'];

export const HERO = {
  kicker: 'The enterprise agentic coding engine',
  headline: { plain: 'This is not', flare: 'a coding assistant.' },
  sub:
    'Autonomous agents that build, review, test, and ship inside your enterprise boundary. ' +
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
    { tone: 'cmd', text: `/sdd implement ${SPINE.req} · AC: 3` },
    { tone: 'agent', text: '✻ ephemeral container in your tenancy, gone on exit' },
    { tone: 'agent', text: '✻ tests first: 9 cases, then the implementation' },
    { tone: 'warn', text: '⚠ spec-enforce: AC3 uncovered, drift is a blocking finding' },
    { tone: 'agent', text: '✻ agent corrects to the plan, writes the missing case' },
    { tone: 'ok', text: '✓ re-verified: AC3 covered, 10 of 10 green, zero drift' },
    { tone: 'agent', text: '✻ PR boundary: /review --deep, 6 agents in parallel' },
    { tone: 'deny', text: '✕ direct provider call denied, rerouted to your AI Gateway' },
    { tone: 'dim', text: '  41 model calls: DLP on egress, every token attributed' },
    { tone: 'ok', text: '✓ specification, implementation and documentation aligned' },
    { tone: 'ok', text: `✓ ${SPINE.pr} ready for triage, CI green, the merge is yours` },
  ] satisfies TranscriptLine[],
  foot: {
    ctx: 'context 18%',
    model: 'opus-4.8',
    reason: 'reasoning high',
    note: SPINE.service,
  } satisfies TerminalFoot,
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
  },
];

export const SHIFT = {
  id: 'shift',
  title: 'Decades of SDLC. One generational leap.',
  lead:
    'Coding assistants made typing faster. Codeflare changes what an engineer <em>is</em>: ' +
    'agents build, test, govern, and ship; the engineer specifies, steers, and judges. ' +
    'Four moments from inside the boundary.',
};

export const METHOD = {
  id: 'method',
  kicker: 'The method',
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
      title: 'Compliance is enforced, not hoped for',
      body:
        'At every PR boundary the spec and TDD enforcers check the diff against its ' +
        'requirements and reject test theater. Drift from the plan is a blocking finding, ' +
        'not a polite suggestion the agent is free to ignore.',
    },
    {
      title: 'A self-healing loop',
      body:
        'Findings route straight back to the agent, which corrects to the spec and ' +
        're-verifies against the codebase and the documentation. Nothing merges until what ' +
        'was built matches what was specified.',
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
      'Drift is a blocking finding. The agent is corrected and re-verified. ' +
      'Specification, implementation and documentation aligned, enforced not hoped for.',
    steps: [
      { actor: 'spec-enforce', state: 'fail', text: 'AC3 is not covered by a test' },
      { actor: 'tdd-enforce', state: 'fail', text: 'an assertion-free test is rejected as theater' },
      { actor: 'agent', state: 'work', text: 'corrects to the plan, writes the missing case' },
      { actor: 'reverify', state: 'pass', text: 'AC3 now verified, 10 of 10 green' },
      { actor: 'merge', state: 'pass', text: 'allowed, zero deviations from the spec' },
    ] satisfies GateStep[],
  },
};

export const SECURITY = {
  id: 'security',
  kicker: 'Security',
  title: 'Zero trust is the architecture, not a policy.',
  lead:
    'Autonomous agents are only safe inside structural boundaries. Codeflare makes the ' +
    'dangerous behaviors impossible to express, not merely discouraged.',
  cards: [
    {
      title: 'Isolated ephemeral containers',
      tag: 'structural',
      body:
        'Every session is its own container, born on demand and destroyed after use. Nothing ' +
        'to escalate into and nowhere to move laterally: the environment ceases to exist.',
    },
    {
      title: 'Identity-gated, your IdP',
      tag: 'identity',
      body:
        'Every request authenticates through Cloudflare Access against Entra ID, Okta, or any ' +
        'SAML/OIDC source you run. No VPNs, instant offboarding by group membership.',
    },
    {
      title: 'Egress governed below the agent',
      tag: 'guardrails + DLP',
      body:
        'LLM traffic is intercepted beneath the container and routed through your AI Gateway, ' +
        'where guardrails, DLP, and rate controls apply. Agents physically cannot reach ' +
        'unapproved endpoints, and provider credentials never enter the container.',
    },
    {
      title: 'Code never touches the device',
      tag: 'data',
      body:
        'Source exists only inside the container and your storage boundary. The endpoint ' +
        'exfiltration surface enterprises spend millions managing simply is not there.',
    },
  ] satisfies Card[],
  microCta: 'Request the security and compliance deep-dive',
};

/** Boundary data-path diagram nodes (browser → access → container → gateway). */
export const BOUNDARY_FLOW = [
  { label: 'Browser', sub: 'zero footprint', accent: false, edge: 'TLS' },
  { label: 'Cloudflare Access', sub: 'your IdP', accent: false, edge: 'authenticated' },
  { label: 'Ephemeral container', sub: 'your tenancy · destroyed on exit', accent: true, edge: 'intercepted' },
  { label: 'Your AI Gateway', sub: 'guardrails · DLP · approved models', accent: false, edge: '' },
];

/** What the boundary makes structurally impossible, not merely discouraged.
 *  Rendered as denied chips beside the data-path so the negative space of the
 *  architecture is as visible as the approved path. */
export const BOUNDARY_BLOCKED = [
  'Direct provider call: denied',
  'Lateral move to a peer session: impossible',
  'Source code on the endpoint device: none',
  'Reach to an unapproved endpoint: blocked',
  'Privilege escalation: nothing to escalate into',
];

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
  caption:
    'One model call, inspected: guardrails pass, DLP redacts one PAN, the route is approved. ' +
    'Nothing leaves the boundary unseen.',
};

export const OPERATIONS = {
  id: 'operations',
  kicker: 'Operations',
  title: 'Not just code. The systems behind it.',
  lead:
    'The same governed agents that ship code can operate the infrastructure it runs on. ' +
    'Through zero-trust, policy-scoped tunnels, a session reaches only the internal systems ' +
    'its policy allows, to orchestrate environments, patch servers, and carry migrations through.',
  cards: [
    {
      title: 'Policy-scoped zero-trust tunnels',
      tag: 'access',
      body:
        'Agents reach internal hosts, databases, and control planes through tunnels gated by ' +
        'Cloudflare Access policy. A session sees only what its group is entitled to, never the ' +
        'flat network: no standing VPN to over-grant, no credentials living in the container.',
    },
    {
      title: 'Operate, not only author',
      tag: 'scope',
      body:
        'Orchestrate infrastructure, patch fleets, run migrations and runbooks, drive incident ' +
        'response. The agent does the work inside the boundary; the same review pipeline and human ' +
        'triage gate the change before anything lands.',
    },
    {
      title: 'Every action attributed',
      tag: 'audit',
      body:
        'Each connection and command flows through the same audited, attributed path as model ' +
        'traffic. Who reached what, when, and under which policy is written to your logs, in your ' +
        'tenancy. No unsigned access, no shadow operations.',
    },
  ] satisfies Card[],
  closing:
    'Same boundary, same attribution, same human triage gate. The engine operates the systems, ' +
    'it does not only author the code.',
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
  kicker: 'The platform',
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
  kicker: 'Context',
  title: 'The open web, rendered clean.',
  lead:
    'Agents pull in external content through isolated browsers. JavaScript-heavy pages and ' +
    'interactive, gated content resolve to their real text, distilled into structured markdown ' +
    'built for agent ingestion rather than raw HTML noise.',
  cards: [
    {
      title: 'Browser-isolated retrieval',
      tag: 'render',
      body:
        'Pages load in a throwaway isolated browser that runs their JavaScript and interactive ' +
        'steps, so single-page apps, dynamic dashboards, and login-gated docs resolve to their ' +
        'real content. The remote page never touches the agent container or your network directly.',
    },
    {
      title: 'Distilled to structured markdown',
      tag: 'distill',
      body:
        'The rendered page is reduced to clean markdown: headings, tables, code, and links kept, ' +
        'chrome and scripts stripped. Token-efficient context an agent can reason over, not a wall ' +
        'of markup.',
    },
    {
      title: 'Straight into the agent',
      tag: 'ingest',
      body:
        'The result lands in the session context or the knowledge graph, so retrieved pages become ' +
        'durable, queryable knowledge. What the agent reasons over is signal, kept inside your boundary.',
    },
  ] satisfies Card[],
  // Browser isolation as a peer-level proof artifact, not buried card prose: the
  // open web crosses an isolation boundary the remote page never breaches, then
  // resolves to agent-ready markdown. Reuses the boundary-flow node idiom.
  pipe: [
    { label: 'source URL', sub: 'the open web', accent: false, edge: 'fetch' },
    { label: 'Isolated browser', sub: 'runs JS, resolves gated content', accent: true, edge: 'distill' },
    { label: 'Structured markdown', sub: 'into the agent and the graph', accent: false, edge: '' },
  ],
  pipeNote:
    'The page renders inside a throwaway isolated browser and never touches the agent container or your network.',
};

export const PIPELINE = {
  id: 'pipeline',
  title: 'Agents become citizens of your pipeline.',
  lead:
    'No shadow toolchain. Agents work through your git, your CI, and your branch protections, ' +
    'subject to the same gates as your engineers. Humans own intent and the merge.',
  cards: [
    {
      title: 'Native git and CI/CD',
      body:
        'Agents push branches, open PRs, and wait on your GitHub Actions like any engineer. ' +
        'Nothing merges without CI green and your branch protections satisfied.',
    },
    {
      title: 'Deep review at every PR boundary',
      body:
        'Each pull request fires /review --deep: six specialist agents check code, security, ' +
        'spec, tests, docs, and end-to-end behavior, filing and fixing findings before a human looks.',
    },
    {
      title: 'Humans own the judgment',
      body:
        'Agents prepare the work; people make the call. Every change lands in a human triage ' +
        'queue with the full review trail attached, and the merge is always yours.',
    },
  ] satisfies Card[],
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
    note: 'CI green, the full review trail attached, the merge owned by a human.',
  },
};

export const COST = {
  id: 'cost',
  kicker: 'Cost',
  title: 'No unattributed dollar in the system.',
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
  layers: [
    {
      name: 'environment',
      body:
        'Serverless pay-per-use in your tenancy: containers exist only while sessions run and ' +
        'hibernate to zero when idle. The bill lands in your cloud account as line items.',
    },
    {
      name: 'inference',
      body:
        'Every request flows through your AI Gateway, where guardrails and DLP apply and ' +
        'metadata makes inference cost visible per user, team, and department. Dynamic routing ' +
        'steers each group to its approved models, and smart routing fails over when a provider degrades.',
    },
    {
      name: 'agent consumption',
      body:
        'Interception sits below the container, so the CLI tools cannot bypass it. Every token ' +
        'any agent consumes is part of the same attributed stream. No shadow AI spend.',
    },
  ] satisfies CostLayer[],
};

export const TENANCY = {
  id: 'tenancy',
  title: 'Runs where your data lives.',
  lead:
    'Codeflare deploys into <strong>your own Cloudflare account</strong>: your tenancy, your ' +
    'keys, your data plane, your audit trail. No vendor in the data path. A guided wizard takes ' +
    'a fresh account to a running engine.',
  checklist: [
    { label: 'Identity', note: 'your IdP' },
    { label: 'Storage', note: 'your R2, your keys' },
    { label: 'AI Gateway', note: 'guardrails, DLP, your rates' },
    { label: 'Domain', note: 'yours' },
  ],
};

export const FAQ_SECTION = {
  id: 'faq',
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

export const FOOTER = {
  tagline: 'The enterprise agentic coding engine.',
  links: [
    { label: 'Book a demo', href: '#contact' },
    { label: 'FAQ', href: '#faq' },
    { label: 'Privacy', href: '/privacy' },
  ] satisfies NavLink[],
};
