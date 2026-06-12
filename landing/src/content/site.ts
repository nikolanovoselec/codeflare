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

export interface Stat {
  value: string;
  label: string;
}

export interface Card {
  title: string;
  body: string;
  tag?: string;
}

export interface ComparisonColumn {
  title: string;
  tag: string;
  points: string[];
}

export interface CostLayer {
  name: string;
  body: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

/** A line in the static review-pipeline snippet. */
export interface SnippetLine {
  kind: 'head' | 'ok';
  strong?: string;
  text: string;
}

export interface TopicOption {
  value: ContactTopic;
  label: string;
}

/** A single static terminal line with its display tone (CSS suffix). */
export interface TranscriptLine {
  tone: 'cmd' | 'agent' | 'ok' | 'dim' | 'warn';
  text: string;
}

export const NAV_LINKS: NavLink[] = [
  { label: 'The shift', href: '#shift' },
  { label: 'Security', href: '#security' },
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

export const TERMINAL = {
  title: 'codeflare/payments-service',
  lines: [
    { tone: 'cmd', text: 'implement rate limiting on the refunds endpoint' },
    { tone: 'agent', text: '✻ planning · querying knowledge graph' },
    { tone: 'dim', text: '  loaded ADR-12 and REQ-API-031 acceptance criteria' },
    { tone: 'agent', text: '✻ writing tests first · 6 cases' },
    { tone: 'ok', text: '✓ 142 tests passed' },
    { tone: 'agent', text: '✻ review: code · security · spec · docs' },
    { tone: 'ok', text: '✓ all reviewers pass · CI green' },
    { tone: 'dim', text: '  38 llm requests → your gateway, attributed' },
    { tone: 'ok', text: '✓ PR #214 ready for human judgment' },
    { tone: 'warn', text: '✓ container destroyed · zero residue' },
  ] satisfies TranscriptLine[],
};

export const STATS: Stat[] = [
  { value: '100%', label: 'of agent LLM traffic routed through your gateway' },
  { value: '0', label: 'lines of code on the endpoint device' },
  { value: '0', label: 'standing infrastructure between sessions' },
  { value: '10×', label: 'one engineer steering parallel agents' },
];

export const SHIFT = {
  id: 'shift',
  title: 'Decades of SDLC. One generational leap.',
  lead:
    'Coding assistants made typing faster. Codeflare changes what an engineer <em>is</em>: ' +
    'the agents do the building, the engineer specifies, steers, and judges.',
  assistant: {
    title: 'Coding assistant',
    tag: 'before',
    points: [
      'Autocompletes while a human types',
      'Suggestions accepted one by one',
      'Lives on a managed developer workstation',
      'Untracked keys, unattributed token spend',
      'Trusted because a human glanced at it',
    ],
  } satisfies ComparisonColumn,
  engine: {
    title: 'Agentic coding engine',
    tag: 'codeflare',
    points: [
      'Agents plan, build, test, document, and ship',
      'Engineers steer intent and make the calls',
      'Runs in your cloud, reached from any browser',
      'Every request through your gateway, attributed',
      'Verified by review pipelines and your CI',
    ],
  } satisfies ComparisonColumn,
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
      tag: 'egress',
      body:
        'LLM traffic is intercepted beneath the container. Agents physically cannot reach ' +
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
  { label: 'Your AI Gateway', sub: 'approved models only', accent: false, edge: '' },
];

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
        'Nothing merges without CI green.',
    },
    {
      title: 'Autonomous review at PR boundaries',
      body:
        'Every pull request fires a review pipeline: code, security, spec, and documentation ' +
        'findings filed and fixed before a human spends a minute.',
    },
    {
      title: 'Tests before trust',
      body:
        'Test-driven discipline is enforced, not encouraged. Review tooling rejects test ' +
        'theater: tests that cannot fail do not count.',
    },
  ] satisfies Card[],
  snippet: [
    { kind: 'head', text: 'on pull_request → review pipeline' },
    { kind: 'ok', strong: 'code-reviewer', text: ' 2 findings, both fixed in-session' },
    { kind: 'ok', strong: 'security-reviewer', text: ' no injection, no secret exposure' },
    { kind: 'ok', strong: 'spec-reviewer', text: ' REQ-PAY-014 acceptance criteria verified' },
    { kind: 'ok', strong: 'doc-updater', text: ' api-reference.md updated in same commit' },
    { kind: 'ok', strong: 'CI green', text: ' ready for human judgment' },
  ] satisfies SnippetLine[],
};

export const COST = {
  id: 'cost',
  kicker: 'Cost',
  title: 'No unattributed dollar in the system.',
  lead:
    'From the infrastructure minute to the inference token to what each agent consumes, ' +
    'visibility and control at every layer, in your own cloud account.',
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
        'Every request flows through your AI Gateway carrying metadata, so inference cost is ' +
        'visible per user, team, and department. Dynamic routing steers each group to its ' +
        'approved models, and smart routing fails over when a provider degrades.',
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
    { label: 'Gateway', note: 'your models, your rates' },
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
      'your AI Gateway with your keys. You pick approved models per group, set rate limits, and ' +
      'see attributed spend. Provider outages fail over automatically, and provider credentials never enter the container.',
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
      'per byte, and your negotiated model rates through the gateway. No per-seat licenses, no ' +
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
