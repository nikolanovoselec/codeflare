/**
 * All landing-page copy and structure, typed. Components render this data;
 * none of them carry their own content. Leads may contain inline HTML
 * (em/strong) — they are build-time trusted content rendered via set:html.
 */
import { CONTACT_TOPICS, type ContactTopic } from '../../../src/lib/contact-topics';
import type { TerminalLine } from '../scripts/terminal-player';

export interface NavLink {
  label: string;
  href: string;
}

export interface Cta {
  label: string;
  href: string;
}

export interface Stat {
  /** Fixed-width boot-assertion key rendered in the preflight ledger. */
  key: string;
  value: string;
  label: string;
}

export interface Card {
  title: string;
  body: string;
  /** Describe-style kind tag, e.g. '[structural]' (security ledger only). */
  tag?: string;
}

/**
 * Section grammar of the governed session: a prompt-path label replaces the
 * eyebrow. stamp is the session-elapsed timestamp (monotonic down the page,
 * agreeing with the status-bar clock), line is the path or command after the
 * prompt glyph, readout is the right-aligned per-section instrument proof,
 * bar is the short segment the status bar shows while the section is active.
 */
export interface SectionPrompt {
  stamp: string;
  line: string;
  readout: string;
  bar: string;
}

export interface SnippetLine {
  ok?: boolean;
  strong?: string;
  text: string;
}

export interface PillarSection {
  id: string;
  prompt: SectionPrompt;
  title: string;
  lead: string;
  alt?: boolean;
  cards?: Card[];
  snippet?: { label: string; lines: SnippetLine[] };
}

export interface ComparisonColumn {
  title: string;
  points: string[];
}

export interface CostLayer {
  name: string;
  body: string;
  /** Dim trace line printed after the layer ('chips' renders the chip row). */
  trace: string;
  /** Attribution metadata chips (inference layer only). */
  chips?: string[];
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface TopicOption {
  value: ContactTopic;
  label: string;
}

/** Terminal transcript line with its display tone (CSS class suffix). */
export interface TranscriptLine extends TerminalLine {
  tone: 'cmd' | 'agent' | 'ok' | 'dim' | 'warn';
}

export const NAV_LINKS: NavLink[] = [
  { label: 'The Shift', href: '#shift' },
  { label: 'Security', href: '#security' },
  { label: 'Scaffolding', href: '#scaffolding' },
  { label: 'Your SDLC', href: '#sdlc' },
  { label: 'Cost', href: '#cost' },
  { label: 'FAQ', href: '#faq' },
];

/**
 * Count-integrity constants: every quantity the page renders visually
 * (transcript lines, readouts, ledger reprises) derives from these, and
 * tests assert the equalities — the fiction can never drift from the copy.
 */
export const REQUEST_COUNT = 38;
export const SKILL_COUNT = '30+';
export const SUBAGENT_COUNT = 11;
export const SESSION_MINUTES = 47;

export const AGENTS = ['claude-code', 'codex', 'copilot', 'pi', 'antigravity', 'opencode'];

export const HERO = {
  motd: 'codeflare · the enterprise agentic coding engine',
  headline: { plain: 'This is not', flare: 'a coding assistant.' },
  sub:
    'Codeflare is where agentic and context engineers direct <strong>fully autonomous coding</strong> — ' +
    'agents that build, review, test, document, and ship inside your enterprise boundary. ' +
    'One engineer, the output of a team. <strong>10× is the operating model, not the marketing.</strong>',
  primaryCta: { label: 'Book a demo', href: '#contact' } satisfies Cta,
  secondaryCta: { label: 'See the shift', href: '#shift' } satisfies Cta,
  bar: '00-boot',
};

export const TERMINAL_WINDOW = {
  title: 'codeflare — payments-service',
  badge: 'isolated container · your-tenancy · eu',
};

export const TERMINAL_TRANSCRIPT: TranscriptLine[] = [
  { kind: 'cmd', tone: 'cmd', text: 'implement rate limiting on the refunds endpoint' },
  { kind: 'spin', tone: 'agent', text: '✻ planning — querying knowledge graph', waitMs: 400 },
  { kind: 'line', tone: 'dim', text: '  → ADR-12: token bucket over sliding window · REQ-API-031 acceptance criteria loaded' },
  { kind: 'spin', tone: 'agent', text: '✻ writing tests first — 6 cases for invalid, burst, and recovery paths', waitMs: 300 },
  { kind: 'spin', tone: 'agent', text: '✻ implementing src/middleware/rate-limit.ts' },
  { kind: 'line', tone: 'ok', text: '✓ 142 tests passed', waitMs: 350 },
  { kind: 'line', tone: 'agent', text: '✻ review fan-out: code · security · spec · docs', waitMs: 500 },
  { kind: 'line', tone: 'ok', text: '  ✓ security-reviewer — no findings', waitMs: 600 },
  { kind: 'line', tone: 'ok', text: '  ✓ spec-reviewer — REQ-API-031 acceptance criteria satisfied', waitMs: 250 },
  { kind: 'cmd', tone: 'cmd', text: 'git push', waitMs: 700 },
  { kind: 'line', tone: 'ok', text: '✓ CI green · PR #214 ready for human judgment', waitMs: 900 },
  { kind: 'line', tone: 'dim', text: `  llm traffic: ${REQUEST_COUNT} requests → your AI Gateway`, waitMs: 700 },
  { kind: 'line', tone: 'dim', text: '  attributed: n.engineer@corp · team:payments · dept:engineering' },
  { kind: 'line', tone: 'dim', text: '  routing: payments → approved models · rate limits enforced' },
  { kind: 'line', tone: 'warn', text: '✓ container destroyed · zero residue', waitMs: 600 },
];

/** Satellite fleet panes the hero terminal splits into — distinct tasks so
 * the concurrency reads as scheduling, not as one animation copied 4×. */
export interface FleetPane {
  title: string;
  badge: string;
  lines: TranscriptLine[];
}

export const FLEET_PANES: FleetPane[] = [
  {
    title: 'web-app',
    badge: 'your-tenancy',
    lines: [
      { kind: 'cmd', tone: 'cmd', text: 'fix the flaky checkout E2E test' },
      { kind: 'spin', tone: 'agent', text: '✻ reproducing — 3 of 200 runs fail', waitMs: 200 },
      { kind: 'line', tone: 'ok', text: '✓ root cause: unawaited navigation' },
      { kind: 'line', tone: 'ok', text: '✓ 200/200 green · PR #221', waitMs: 250 },
      { kind: 'line', tone: 'dim', text: '  attributed: m.dev@corp · team:web' },
    ],
  },
  {
    title: 'data-pipeline',
    badge: 'your-tenancy',
    lines: [
      { kind: 'cmd', tone: 'cmd', text: 'migrate events table to partitioned schema' },
      { kind: 'spin', tone: 'agent', text: '✻ writing migration + backfill plan', waitMs: 350 },
      { kind: 'line', tone: 'ok', text: '✓ dry run: 41M rows · zero loss' },
      { kind: 'line', tone: 'ok', text: '✓ PR #119 awaiting human judgment', waitMs: 200 },
      { kind: 'line', tone: 'dim', text: '  attributed: s.eng@corp · team:data' },
    ],
  },
  {
    title: 'infra',
    badge: 'your-tenancy',
    lines: [
      { kind: 'cmd', tone: 'cmd', text: 'rotate KMS keys across staging' },
      { kind: 'spin', tone: 'agent', text: '✻ terraform plan — 12 resources', waitMs: 300 },
      { kind: 'line', tone: 'ok', text: '✓ policy checks pass · no drift' },
      { kind: 'line', tone: 'ok', text: '✓ PR #87 ready for review', waitMs: 250 },
      { kind: 'line', tone: 'dim', text: '  attributed: o.sre@corp · team:platform' },
    ],
  },
];

/** The four boot assertions printed before the session shows a prompt —
 * which is itself the security story. Same four facts as before, no
 * display-size stat-strip grammar. */
export const STATS: Stat[] = [
  { key: 'egress', value: '100%', label: 'of agent traffic through your gateway — routed, rate-limited, attributed' },
  { key: 'endpoint', value: '0', label: 'lines of code on endpoint devices — ever' },
  { key: 'infra', value: '0', label: 'standing infrastructure — containers exist only while sessions run' },
  { key: 'operator', value: '10×', label: 'one engineer steering parallel autonomous sessions' },
];

export const SHIFT = {
  id: 'shift',
  prompt: {
    stamp: '[00:04:18]',
    line: '~/codeflare/01-the-shift',
    readout: 'operator: 1 · output: a team',
    bar: '01-the-shift',
  } satisfies SectionPrompt,
  title: 'Decades of SDLC. One generational leap.',
  lead:
    'Coding assistants made typing faster. Codeflare changes what an engineer <em>is</em>: ' +
    'the agents do the building — the engineer specifies, steers, and judges. Adoption is safe ' +
    'not because the agents are trusted, but because every change they make is verified by pipeline.',
  assistant: {
    title: 'Coding assistant',
    points: [
      'Autocompletes while a human types',
      'Suggestions you accept one by one',
      'Lives on a managed developer workstation',
      'Untracked API keys, unattributed token spend',
      'Output trusted because a human glanced at it',
      'A seat per developer',
    ],
  } satisfies ComparisonColumn,
  engine: {
    title: 'Agentic coding engine',
    points: [
      'Agents plan, build, test, document, and ship autonomously',
      'Engineers steer intent and make the judgment calls',
      'Runs in isolated ephemeral containers in your cloud — any device, just a browser',
      'Every request through your gateway: routed, rate-limited, attributed',
      'Output verified by autonomous review pipelines and your CI',
      'An engine per organization',
    ],
  } satisfies ComparisonColumn,
};

export const PILLAR_SECTIONS: PillarSection[] = [
  {
    id: 'security',
    prompt: {
      stamp: '[00:09:02]',
      line: '~/codeflare/02-security',
      readout: 'standing infra: 0',
      bar: '02-security',
    },
    title: "Zero trust isn't a policy here. It's the architecture.",
    lead:
      'Autonomous agents are only safe inside structural boundaries. Codeflare doesn’t ask you to ' +
      'trust agent behavior — it makes the dangerous behaviors impossible to express.',
    alt: true,
    cards: [
      {
        title: 'Isolated ephemeral containers',
        tag: '[structural]',
        body:
          'Every session is its own container, created on demand and destroyed after use. No shared ' +
          'shells, no cross-session access, no standing servers. Privilege escalation and lateral ' +
          'movement have nothing to escalate into — the environment ceases to exist.',
      },
      {
        title: 'Identity-gated, your IdP',
        tag: '[identity]',
        body:
          'Every request authenticates through Cloudflare Access against your existing identity ' +
          'provider — Entra ID, Okta, any SAML/OIDC source. No VPNs, no implicit network trust, ' +
          'instant offboarding via group membership.',
      },
      {
        title: 'Egress governed below the agent',
        tag: '[egress]',
        body:
          'LLM traffic is intercepted at the platform layer, beneath the container. Agents physically ' +
          'cannot reach unapproved model endpoints, and provider credentials never enter the ' +
          'container at all.',
      },
      {
        title: 'Encrypted at rest, everywhere',
        tag: '[crypto]',
        body:
          'Workspace storage, credentials, and vault data are encrypted at rest (AES-256-GCM), with ' +
          'customer-provided key options. Data in transit is TLS end to end.',
      },
      {
        title: 'Data loss prevention by design',
        tag: '[dlp]',
        body:
          'Source code exists only inside the container and your storage boundary — never on the ' +
          'endpoint device, never with a third-party vendor. The exfiltration surface enterprises ' +
          'spend millions managing simply isn’t there.',
      },
      {
        title: 'A hardened platform itself',
        tag: '[platform]',
        body:
          'CodeQL static analysis, OSSF Scorecard, Trivy container scanning, dependency review, and ' +
          'weekly automated penetration tests run against the platform — the same rigor the engine ' +
          'enforces on your code.',
      },
    ],
  },
  {
    id: 'zero-footprint',
    prompt: {
      stamp: '[00:15:40]',
      line: 'man codeflare-session',
      readout: 'endpoint footprint: 0 bytes',
      bar: '03-zero-footprint',
    },
    title: 'It runs in a browser. So it runs everywhere.',
    lead:
      'The engine is already running in your cloud — a session is just a URL. The endpoint device ' +
      'becomes a window, not an asset to manage.',
    cards: [
      {
        title: 'Nothing to deploy',
        body:
          'No golden images, no developer workstation builds, no local toolchains to patch. Full ' +
          'Linux environments with every agent pre-installed, born in seconds.',
      },
      {
        title: 'Onboarding is IAM configuration',
        body:
          'Add a user to the Access group in your identity provider — that’s the entire provisioning ' +
          'workflow. Day-one productivity for hires, same-day offboarding with nothing to reclaim or wipe.',
      },
      {
        title: 'Contractors without the device lifecycle',
        body:
          'No shipping managed laptops, no MDM enrollment, no return logistics. A contractor’s own ' +
          'device is fine — source code never touches it.',
      },
      {
        title: 'Steer your agents from anywhere',
        body:
          'Autonomous sessions keep working whether you’re watching or not. Review findings and ' +
          'redirect agents from a laptop, a tablet, or a phone — supervising an agent fleet doesn’t ' +
          'require a workstation.',
      },
    ],
  },
  {
    id: 'scaffolding',
    prompt: {
      stamp: '[00:22:11]',
      line: 'codeflare session --new',
      readout: `skills: ${SKILL_COUNT} · subagents: ${SUBAGENT_COUNT}`,
      bar: '04-scaffolding',
    },
    title: 'Agents arrive equipped, not naive.',
    lead:
      'The difference between dropping a raw CLI agent into a repository and deploying one that ' +
      'already knows your standards, your patterns, and your history. Every session is seeded with ' +
      'enterprise tooling the moment it starts.',
    alt: true,
    cards: [
      {
        title: 'Any agent, one engine',
        body:
          'Claude Code, Codex, GitHub Copilot, Pi, Antigravity, OpenCode — pick per session. The ' +
          'governance, scaffolding, and isolation are identical regardless of which agent does the work.',
      },
      {
        title: `${SKILL_COUNT} skills`,
        body:
          'Spec-driven development, CI monitoring, deployment patterns, API design, database ' +
          'migrations, security checklists — operational knowledge agents load on demand instead of ' +
          'rediscovering.',
      },
      {
        title: `${SUBAGENT_COUNT} specialist subagents`,
        body:
          'Architect, code reviewer, security reviewer, spec enforcer, TDD guide, documentation ' +
          'maintainer and more — autonomous specialists the lead agent delegates to, in parallel.',
      },
      {
        title: 'Knowledge graph memory',
        body:
          'Repositories, documents, and decisions are ingested into a queryable graph. Agents recall ' +
          'last quarter’s architecture decision instead of contradicting it — across sessions, across ' +
          'the team.',
      },
      {
        title: 'Spec-driven development, enforced',
        body:
          'Requirements with acceptance criteria live next to the code — and enforcement pipelines ' +
          'verify them at every PR boundary. Other tools help you write specs; Codeflare makes drift ' +
          'a build failure.',
      },
      {
        title: 'Persistent vault & MCP tooling',
        body:
          'An encrypted, session-synced vault for team knowledge, plus Model Context Protocol servers ' +
          'for graph queries, context management, and second-opinion LLM consultation — wired into ' +
          'every session.',
      },
    ],
  },
  {
    id: 'sdlc',
    prompt: {
      stamp: '[00:29:55]',
      line: 'git log --graph codeflare/your-pipeline',
      readout: 'gates: yours',
      bar: '05-your-sdlc',
    },
    title: 'Agents become citizens of your pipeline. Not a parallel universe.',
    lead:
      'No rip-and-replace, no shadow toolchain. Agents work through your existing git workflow and ' +
      'are subject to the same controls as your humans — branches, pull requests, your CI gates, ' +
      'your deploy pipelines.',
    cards: [
      {
        title: 'Native git & CI/CD flow',
        body:
          'Agents push branches, open PRs, and wait on your GitHub Actions like any engineer. Nothing ' +
          'merges without CI green — agent code earns its way in through the same gates.',
      },
      {
        title: 'Autonomous review at PR boundaries',
        body:
          'Every pull request fires a review pipeline: code quality, security, spec compliance, ' +
          'documentation drift — findings filed and fixed before a human reviewer spends a minute.',
      },
      {
        title: 'Tests before trust',
        body:
          'Test-driven discipline is enforced, not encouraged: agents write failing tests first, and ' +
          'review tooling rejects test theater — tests that can’t fail don’t count.',
      },
      {
        title: 'Humans at the judgment points',
        body:
          'Engineers define intent, review the verified result, and own the merge. The engine ' +
          'compresses everything between those two moments.',
      },
    ],
    snippet: {
      label: 'Example of the autonomous review pipeline output',
      lines: [
        { text: 'on pull_request → review pipeline' },
        { ok: true, strong: 'code-reviewer', text: ' — 2 findings, both fixed in-session' },
        { ok: true, strong: 'security-reviewer', text: ' — no injection, no secret exposure' },
        { ok: true, strong: 'spec-reviewer', text: ' — REQ-PAY-014 acceptance criteria verified' },
        { ok: true, strong: 'doc-updater', text: ' — api-reference.md updated in same commit' },
        { ok: true, text: ' CI green — ready for human judgment' },
      ],
    },
  },
];

export const COST = {
  id: 'cost',
  prompt: {
    stamp: '[00:36:08]',
    line: 'codeflare cost --attribution',
    readout: 'unattributed: $0.00',
    bar: '06-cost',
  } satisfies SectionPrompt,
  title: 'There is no unattributed dollar in this system.',
  lead:
    'From the infrastructure minute to the inference token to what each coding agent consumes ' +
    'inside each terminal — visibility and control at every layer, in your own cloud account.',
  /** Reprise readout above the trace, tied to the hero transcript by test. */
  reprise: `gateway: ${REQUEST_COUNT} requests · all attributed`,
  layers: [
    {
      name: 'environment',
      body:
        'Serverless pay-per-use in your own tenancy: containers exist only while sessions run and ' +
        'hibernate to zero when idle. Cumulative usage is visible on the platform, and the bill lands ' +
        'in your cloud account as line items — not in a vendor’s per-seat price.',
      trace: '· container minutes → your cloud bill, line-itemed',
    },
    {
      name: 'inference',
      body:
        'Every LLM request flows through your AI Gateway carrying metadata — so inference cost is ' +
        'visible per user, per team, per department, per group, at whatever granularity you ' +
        'configure. Dynamic routing steers each group to its approved models; rate limits hold the line.',
      trace: 'chips',
      chips: ['user:n.engineer', 'team:payments', 'dept:engineering'],
    },
    {
      name: 'agent-consumption',
      body:
        'Interception happens below the container, so the CLI tools themselves can’t bypass it. ' +
        'Every token any agent consumes inside any session is part of the same attributed stream. ' +
        'No shadow AI spend, no blind spots.',
      trace: '= one attributed stream · no shadow AI spend',
    },
  ] satisfies CostLayer[],
};

export const TENANCY = {
  id: 'tenancy',
  prompt: {
    stamp: '[00:41:30]',
    line: 'codeflare setup',
    readout: 'codeflare services in your data path: 0',
    bar: '07-tenancy',
  } satisfies SectionPrompt,
  title: 'Runs where your data lives.',
  lead:
    'Codeflare deploys into <strong>your own Cloudflare account</strong> — your tenancy, your keys, your data ' +
    'plane, your audit trail. Completely cloud delivered with nothing to rack, and no vendor in the ' +
    'data path. A guided setup wizard takes a fresh account to a running engine: identity, storage, ' +
    'gateway, and domain — configured, not coded.',
  setup: [
    '✓ identity — your IdP',
    '✓ storage — your R2, your keys',
    '✓ gateway — your models, your rates',
    '✓ domain — yours',
  ],
  setupClose: 'configured, not coded',
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: 'Where does our code and data live?',
    answer:
      'Inside your own Cloudflare account — workspace storage in your R2 buckets, metadata in your ' +
      'KV namespaces, sessions in containers under your tenancy. Codeflare is software you run, not ' +
      'a service that holds your data. Storage is encrypted at rest, with customer-provided key options.',
  },
  {
    question: 'How do agents reach LLM providers?',
    answer:
      'They don’t — not directly. All model traffic is intercepted at the platform layer and routed ' +
      'through your AI Gateway with your keys. You choose the approved models per group, set rate ' +
      'limits, and see attributed spend per user, team, or department. Provider credentials never ' +
      'enter the container.',
  },
  {
    question: 'How does authentication work with our IdP?',
    answer:
      'Through Cloudflare Access in front of every surface — federating to Entra ID, Okta, Google ' +
      'Workspace, or any SAML/OIDC provider you already run. Provisioning is group membership; ' +
      'offboarding is group removal.',
  },
  {
    question: 'What stops an agent from escalating privileges or reaching internal systems?',
    answer:
      'Structure, not policy. Each session runs in its own ephemeral container with no peers to move ' +
      'to, no standing infrastructure to persist on, and zero-trust access in front of every ' +
      'internal surface. When the session ends, the container is destroyed.',
  },
  {
    question: 'Which coding agents are supported?',
    answer:
      'Claude Code, OpenAI Codex, GitHub Copilot, Pi, Google Antigravity, and OpenCode — selectable ' +
      'per session, with the same isolation and governance regardless of choice. Enterprise ' +
      'deployments can restrict the set to gateway-compatible agents.',
  },
  {
    question: 'What does it cost to run?',
    answer:
      'Pay-per-use on your own Cloudflare bill: container minutes while sessions run (hibernating to ' +
      'zero when idle), storage per byte, and your negotiated model rates through the gateway. No ' +
      'per-seat licenses, no idle fleet, and no vendor margin on your inference.',
  },
  {
    question: 'Does this replace our existing SDLC tooling?',
    answer:
      'No — it works through it. Agents use your git hosting, your CI, your deploy pipelines, and ' +
      'your branch protections. The autonomous review pipeline adds gates; it doesn’t remove any.',
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
  prompt: {
    stamp: '[00:46:15]',
    line: '~/codeflare/09-book-a-demo',
    readout: 'response: 1–2 business days',
    bar: '09-book-a-demo',
  } satisfies SectionPrompt,
  title: 'Bring agentic coding inside the enterprise boundary.',
  aside: [
    'Whether you’re evaluating agentic coding for the first time, planning a pilot, or need a ' +
      'security and compliance deep-dive before adoption — let’s talk about your environment ' +
      'specifically.',
    'Your message goes directly to the team that builds Codeflare. Expect a response within 1–2 ' +
      'business days. Submissions are protected by Cloudflare Turnstile and are not stored — they ' +
      'arrive as email and nothing else.',
  ],
  topics: CONTACT_TOPICS.map((value) => ({ value, label: TOPIC_LABELS[value] })) satisfies TopicOption[],
};

export const FAQ_SECTION = {
  id: 'faq',
  prompt: {
    stamp: '[00:44:02]',
    line: '~/codeflare/08-procurement-will-ask',
    readout: 'questions procurement will ask',
    bar: '08-faq',
  } satisfies SectionPrompt,
  title: 'The answers, up front.',
};

/**
 * Security boundary diagram (ASCII, ≤38ch so it never overflows a 360px
 * viewport at 11px mono). aria-hidden in markup; PROSE_TWIN is the
 * screen-reader narrative. Callouts use precise claims — no absolutes that
 * fold under hostile reading.
 */
export const BOUNDARY = {
  diagram: [
    '   [ browser · zero footprint ]',
    '              │ tls',
    '  ════ cloudflare access ════',
    '         · your IdP ·',
    '              │',
    '  ┌╌╌ ephemeral container ╌╌┐',
    '  ╎  agents work in here    ╎',
    '  ╎  · your tenancy ·       ╎',
    '  └╌╌ destroyed on exit ╌╌╌╌┘',
    '              │ intercepted',
    '  ═══ your AI Gateway ═══',
    '     → approved models',
  ],
  callouts: [
    'endpoint exfiltration surface: none — code never touches the device',
    'no codeflare-operated service in your data path',
  ],
  proseTwin:
    'Data path: the browser holds no code. Every request authenticates through Cloudflare ' +
    'Access against your identity provider, reaches an ephemeral container in your tenancy ' +
    'that is destroyed on exit, and all LLM traffic is intercepted below the container and ' +
    'routed through your AI Gateway to approved models. No Codeflare-operated service sits ' +
    'in the data path.',
};

/** Man page artifact for the zero-footprint section. */
export const MAN_PAGE = {
  header: 'CODEFLARE-SESSION(1)',
  name: 'codeflare-session — it runs in a browser, so it runs everywhere',
  synopsis: 'https://codeflare.<your-domain>/session',
  deviceReadout: 'PR #214 · review findings: 2',
  devices: ['laptop', 'tablet', 'phone'],
  footer: 'CODEFLARE(1)',
};

/**
 * Annotated seed log: what every session is born with (scaffolding).
 * Index-paired with the scaffolding section's cards — the log line is the
 * machine event, the card body is its annotation. 'agents' is the sentinel
 * for the agent-chip row rendered from AGENTS.
 */
export const SEED_LOG = [
  'agents',
  `✓ mounting skills … ${SKILL_COUNT} loaded`,
  `✓ registering subagents … ${SUBAGENT_COUNT} specialists`,
  '✓ attaching knowledge graph',
  '✓ enforcing spec-driven development',
  '✓ syncing vault · wiring MCP',
];

/** Destroy finale: the page enacts its own threat model, then goes quiet. */
export const SESSION_END = {
  id: 'session-end',
  bar: 'session-end',
  exit: 'exit',
  lines: ['✓ work delivered through your pipeline', '✓ container destroyed · zero residue'],
};
