import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import IndexPage from '../pages/index.astro';
import PrivacyPage from '../pages/privacy.astro';
import { APP_LINKS } from '../config';
import {
  AGENTS,
  BROWSER,
  CONTACT_FORM,
  COST,
  DOGFOOD,
  GITHUB_URL,
  EGRESS,
  FAQ_ITEMS,
  FEATURE_TERMINALS,
  HERO,
  CONTEXT,
  LEGACY,
  METHOD,
  NAV_LINKS,
  OPERATIONS,
  PLATFORM,
  PIPELINE,
  SECURITY,
  SHIFT,
  SPINE,
  TENANCY,
  TERMINAL,
} from '../content/site';

let html: string;
/** Rendered HTML with Astro's entity escaping undone, for raw-copy assertions. */
let text: string;

function decodeEntities(rendered: string): string {
  return rendered
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

beforeAll(async () => {
  const container = await AstroContainer.create();
  html = await container.renderToString(IndexPage);
  text = decodeEntities(html);
});

describe('landing page (REQ-LANDING-001)', () => {
  it('renders the hero: positioning kicker, two-part headline, sub, and both CTAs', () => {
    expect(text).toContain(HERO.kicker);
    expect(html).toContain(HERO.headline.plain);
    expect(html).toContain(HERO.headline.flare);
    expect(html).toContain('class="flare"');
    expect(text).toContain(HERO.sub.slice(0, 50));
    expect(html).toContain(`href="${HERO.primaryCta.href}"`);
    expect(html).toContain(`href="${HERO.secondaryCta.href}"`);
    // The flare word carries the scramble hook (the effect itself is client-only).
    expect(html).toContain('data-scramble');
    // The page hosts the flare-fluid mount point (a fixed full-page layer; the
    // canvas is injected client-side on desktop).
    expect(html).toContain('data-flare-fluid');
    // The hero spine strip names the run as the page's quiet table of contents.
    expect(html).toContain('hero-spine');
    expect(text).toContain(SPINE.req);
    expect(text).toContain(SPINE.pr);
    // The hero terminal carries a live prompt loop (the shared feature-terminal
    // engine): the resting state is the first looped command, typed after the
    // transcript with the same ft-typed/caret markup as the feature terminals.
    expect(html).toContain('data-ft-loop');
    expect(html).toContain('data-ft-typed');
    expect(text).toContain(TERMINAL.loop[0]);
  });

  it('renders the hero transcript as the governed run: a visible drift, an egress denial, and the alignment refrain', () => {
    // The enforcement narrative the buyer must see: spec-enforce catches a drift,
    // a direct provider call is denied, and the verbatim alignment line lands.
    expect(html).toContain('t-warn');
    expect(html).toContain('t-deny');
    expect(text).toContain('drift is a blocking finding');
    expect(text).toContain('direct provider call denied');
    expect(text).toContain('specification, implementation and documentation aligned');
    // The same spine PR closes the transcript.
    expect(text).toContain(SPINE.pr);
  });

  it('exposes a launch path into the app (Sign in -> /login)', () => {
    expect(html).toContain(`href="${APP_LINKS.signIn}"`);
    expect(html).toContain('Sign in');
  });

  it('renders the one terminal demo statically (legible with no JS)', () => {
    expect(html).toContain(TERMINAL.title);
    for (const line of TERMINAL.lines) {
      // None of the transcript lines contain HTML-escapable characters.
      expect(html).toContain(line.text);
    }
  });

  it('renders every nav link and a matching target section id', () => {
    for (const link of NAV_LINKS) {
      expect(html).toContain(link.label);
      expect(html).toContain(`id="${link.href.replace('#', '')}"`);
    }
    expect(html).toContain('id="contact"');
  });

  it('renders the shift as a feature-terminal grid: every tile title, line, and caption foot', () => {
    expect(html).toContain('id="shift"');
    expect(text).toContain(SHIFT.title);
    expect(html).toContain('feature-terminals');
    for (const ft of FEATURE_TERMINALS) {
      expect(text).toContain(ft.title);
      expect(text).toContain(ft.foot);
      for (const line of ft.lines) {
        // Some lines carry an apostrophe Astro escapes, so assert on the
        // entity-decoded copy rather than the raw HTML.
        expect(text).toContain(line.text);
      }
    }
  });

  it('renders the hero terminal agent statusline foot (context, model, reasoning)', () => {
    expect(html).toContain('data-agentfoot');
    expect(text).toContain(TERMINAL.foot.ctx);
    expect(text).toContain(TERMINAL.foot.model);
    expect(text).toContain(TERMINAL.foot.reason);
    // The animated segments expose hooks the static foot resolves on its own.
    expect(html).toContain('data-tf-ctx');
    expect(html).toContain('data-tf-reason');
  });

  it('renders the method section: spec-driven development as a standout with the self-healing trace', () => {
    expect(html).toContain('id="method"');
    expect(text).toContain(METHOD.title);
    for (const pillar of METHOD.pillars) {
      expect(text).toContain(pillar.title);
      expect(text).toContain(pillar.body.slice(0, 40));
    }
    // The self-healing enforcement gate renders the requirement plus a real
    // drift caught and corrected (not an all-green log): every step, with at
    // least one failed enforcer and a passing resolution.
    expect(html).toContain('data-proof');
    expect(text).toContain(METHOD.gate.req);
    expect(text).toContain(METHOD.gate.criterion);
    for (const step of METHOD.gate.steps) {
      expect(text).toContain(step.actor);
      expect(text).toContain(step.text);
    }
    expect(METHOD.gate.steps.some((s) => s.state === 'fail')).toBe(true);
    expect(html).toContain('is-fail');
    expect(html).toContain('is-pass');
    // The gate caption states the enforcement refrain in plain words, and the
    // three pillars render as numbered clauses of a control (not a card grid).
    expect(text).toContain(METHOD.gate.caption.slice(0, 40));
    expect(html).toContain('method-clauses');
  });

  it('renders the security boundary as one merged gate: approved and impossible paths, then the egress call, under one foot', () => {
    expect(html).toContain('id="security"');
    expect(text).toContain(SECURITY.title);
    expect(html).toContain('data-topic="security-compliance"');
    // The boundary is one coherent gate (no diagram plus a loose denied-list):
    // every row renders its actor, state label, and text, with at least one
    // approved path and one the architecture makes impossible.
    expect(html).toContain('gate boundary');
    expect(text).toContain(SECURITY.boundary.title);
    for (const row of SECURITY.boundary.rows) {
      expect(text).toContain(row.actor);
      expect(text).toContain(row.label);
      expect(text).toContain(row.text);
    }
    expect(SECURITY.boundary.rows.some((r) => r.state === 'pass')).toBe(true);
    expect(SECURITY.boundary.rows.some((r) => r.state === 'deny')).toBe(true);
    expect(html).toContain('is-deny');
    // Security + egress are now ONE terminal: a single in-chrome foot carries the
    // merged caption, and there is no separate egress terminal.
    expect(text).toContain(SECURITY.boundary.caption.slice(0, 40));
    expect(html).toContain('gate-subhead');
    expect(html).not.toContain('gate egress');
    // The AI Gateway is named as the egress control.
    expect(text).toContain('your AI Gateway');
  });

  it('renders the dogfood proof: this page as REQ-LANDING-001 with real anchors, an in-chrome foot, and a GitHub link', () => {
    expect(html).toContain('id="dogfood"');
    expect(text).toContain(DOGFOOD.title);
    expect(text).toContain(DOGFOOD.terminalTitle);
    for (const line of DOGFOOD.lines) {
      expect(text).toContain(line.text);
    }
    // The amplified transcript names the requirement status and the shipping PR.
    expect(text).toContain('Status: Implemented');
    expect(text).toContain('PR #533');
    // The terminal closes on a normalized in-chrome foot like every other one.
    expect(text).toContain(DOGFOOD.foot);
    // The dogfood CTA is now the page's only GitHub link (the footer no longer
    // carries one); it points at the public repo.
    expect(html).toContain(`href="${GITHUB_URL}"`);
    expect(text).toContain(DOGFOOD.cta.label);
  });

  it('renders the egress rows inside the merged boundary terminal: guardrails pass, a DLP redaction, and an approved route', () => {
    // DLP and guardrails become auditable evidence, not asserted claims. The
    // egress call now renders as a sub-labelled rows block inside the one
    // security boundary terminal (#7), introduced by the gate-subhead.
    expect(text).toContain(EGRESS.call);
    expect(html).toContain('gate-subhead');
    for (const row of EGRESS.rows) {
      expect(text).toContain(row.actor);
      expect(text).toContain(row.text);
    }
    // The one amber beat: a DLP redaction rendered as a first-class state.
    expect(EGRESS.rows.some((r) => r.state === 'redact')).toBe(true);
    expect(html).toContain('is-redact');
  });

  it('renders the operations section: infrastructure beyond code via zero-trust tunnels', () => {
    expect(html).toContain('id="operations"');
    expect(text).toContain(OPERATIONS.title);
    // The load-bearing capability: policy-scoped zero-trust tunnels to internal systems.
    expect(text).toContain('zero-trust');
    expect(text).toContain('tunnels');
    for (const card of OPERATIONS.cards) {
      expect(text).toContain(card.title);
      expect(text).toContain(card.body.slice(0, 40));
    }
  });

  it('renders the context section: browser-isolated web ingestion to agent-ready markdown', () => {
    expect(html).toContain('id="context"');
    expect(text).toContain(CONTEXT.title);
    // The load-bearing capability: isolated-browser rendering distilled to markdown.
    expect(text).toContain('isolated browser');
    expect(text).toContain('markdown');
    expect(text).toContain('ingestion');
    // The isolation proof terminal is a peer-level proof artifact: each line plus
    // the load-bearing guarantee that the remote page never touches the container.
    expect(html).toContain('context-terminal');
    for (const line of CONTEXT.terminal.lines) {
      expect(text).toContain(line.text);
    }
    expect(text).toContain(CONTEXT.terminal.foot);
  });

  it('renders the browser, platform, pipeline, cost, and tenancy sections', () => {
    expect(text).toContain(BROWSER.title);
    expect(text).toContain(PLATFORM.title);
    expect(text).toContain(PIPELINE.title);
    expect(text).toContain(COST.title);
    expect(text).toContain(TENANCY.title);
    for (const agent of AGENTS) {
      expect(html).toContain(agent);
    }
    for (const card of COST.cards) {
      expect(text).toContain(card.body.slice(0, 40));
    }
    // The attribution ledger: every line carries an owner, and the closing
    // total reads zero unattributed (the load-bearing cost claim). The ledger is
    // bound to the spine run, and the sample note reconciles the visible rows
    // with the full-run totals.
    expect(html).toContain('ledger-totals');
    expect(html).toContain('ledger-meta');
    expect(text).toContain(COST.ledger.meta);
    expect(text).toContain(COST.ledger.sample);
    for (const row of COST.ledger.rows) {
      expect(text).toContain(row.agent);
    }
    const unattributed = COST.ledger.totals.find((t) => t.label === 'unattributed');
    expect(unattributed).toBeDefined();
    expect(unattributed?.accent).toBe(true);
    expect(text).toContain(unattributed!.value);
  });

  it('renders the parallel review board: every reviewer lane, a caught finding, and the human triage verdict', () => {
    expect(html).toContain('review-board');
    expect(text).toContain(PIPELINE.trigger);
    // The overhead conductor label makes the fan-out under one human gate explicit.
    expect(html).toContain('board-dispatch');
    expect(text).toContain(PIPELINE.dispatch);
    for (const lane of PIPELINE.lanes) {
      expect(html).toContain(lane.agent);
      expect(text).toContain(lane.note);
    }
    // The board shows findings caught and re-proven, not only clean lanes.
    expect(PIPELINE.lanes.some((l) => l.result === 'finding')).toBe(true);
    expect(html).toContain('is-finding');
    expect(text).toContain(PIPELINE.verdict.title);
    expect(text).toContain(PIPELINE.verdict.note);
  });

  it('renders every FAQ question', () => {
    for (const item of FAQ_ITEMS) {
      expect(text).toContain(item.question);
    }
  });

  it('renders the contact form with all fields and every backend-accepted topic', () => {
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="company"');
    expect(html).toContain('name="topic"');
    expect(html).toContain('name="message"');
    for (const topic of CONTACT_FORM.topics) {
      expect(html).toContain(`value="${topic.value}"`);
    }
  });

  it('renders the legacy-rescue station between method and security: the /sdd init + /sdd clean transcript', () => {
    expect(html).toContain('id="legacy"');
    expect(text).toContain(LEGACY.title);
    expect(text).toContain(LEGACY.lead.slice(0, 40));
    expect(text).toContain(LEGACY.terminal.title);
    for (const line of LEGACY.terminal.lines) {
      expect(text).toContain(line.text);
    }
    // The terminal closes on a normalized in-chrome foot.
    expect(text).toContain(LEGACY.terminal.foot);
    // Both rescue motions are shown: bootstrapping a baseline and realigning drift.
    expect(text).toContain('/sdd init --import legacy-payments');
    expect(text).toContain('/sdd clean');
  });

  it('renders the station spine: a numbered marker on each instrument station, in render order', () => {
    expect(html).toContain('station-marker');
    // The instrument stations carry data-station and their marker number; the
    // numbering runs in render order (method -> legacy -> security -> context ->
    // pipeline -> cost) and the calmer tail stays un-numbered.
    for (const section of [METHOD, LEGACY, SECURITY, CONTEXT, PIPELINE, COST]) {
      expect(html).toContain(`data-station="${section.station.n}"`);
      expect(text).toContain(section.station.label);
    }
    expect([METHOD, LEGACY, SECURITY, CONTEXT, PIPELINE, COST].map((s) => s.station.n)).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
    ]);
  });

  it('drops the GitHub link from the footer (the dogfood CTA is now the only one)', () => {
    // The footer is one quiet centered line: no GitHub mark or repo link.
    expect(html).not.toContain('footer-gh');
    expect(html).not.toContain('Codeflare on GitHub');
    // The page still links to the repo exactly once, via the dogfood CTA.
    const occurrences = html.split(`href="${GITHUB_URL}"`).length - 1;
    expect(occurrences).toBe(1);
  });

  it('drops the old terminal-session chrome (no status bar, fleet, or animated transcript)', () => {
    expect(html).not.toContain('id="statusbar"');
    expect(html).not.toContain('data-fleet=');
    expect(html).not.toContain('data-tt=');
    expect(html).not.toContain('flare-block');
  });

  it('uses no em-dash or en-dash anywhere in the rendered copy', () => {
    expect(text).not.toMatch(/[–—]/);
  });
});

describe('landing page metadata (REQ-LANDING-003)', () => {
  const requiredOgTags = [
    'og:type',
    'og:site_name',
    'og:title',
    'og:description',
    'og:url',
    'og:image',
    'og:image:width',
    'og:image:height',
    'og:image:alt',
    'og:locale',
  ];

  it('exposes the full Open Graph tag set', () => {
    for (const tag of requiredOgTags) {
      expect(html).toContain(`property="${tag}"`);
    }
    expect(html).toContain('content="1200"');
    expect(html).toContain('content="630"');
  });

  it('exposes Twitter summary_large_image card metadata', () => {
    expect(html).toContain('name="twitter:card"');
    expect(html).toContain('content="summary_large_image"');
    expect(html).toContain('name="twitter:title"');
    expect(html).toContain('name="twitter:description"');
    expect(html).toContain('name="twitter:image"');
    expect(html).toContain('name="twitter:image:alt"');
  });

  it('sets the canonical URL to the served root, not the /landing asset path', () => {
    expect(html).toContain('rel="canonical" href="https://codeflare.ch/"');
  });

  it('describes the enterprise positioning in the meta description', () => {
    expect(html).toMatch(/<meta name="description" content="[^"]*agentic coding engine[^"]*"/);
  });
});

describe('privacy page (REQ-LANDING-002)', () => {
  it('renders the privacy policy with the no-storage contact form disclosure', async () => {
    const container = await AstroContainer.create();
    const privacyHtml = await container.renderToString(PrivacyPage);

    expect(privacyHtml).toContain('Privacy');
    expect(privacyHtml).toContain('Turnstile');
    // The load-bearing claim: submissions are relayed as email, not persisted.
    expect(privacyHtml.toLowerCase()).toContain('not stored');
  });
});
