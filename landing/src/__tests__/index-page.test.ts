import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import IndexPage from '../pages/index.astro';
import PrivacyPage from '../pages/privacy.astro';
import { APP_LINKS } from '../config';
import {
  AGENTS,
  BOUNDARY_BLOCKED,
  BROWSER,
  CONTACT_FORM,
  COST,
  FAQ_ITEMS,
  HERO,
  CONTEXT,
  METHOD,
  NAV_LINKS,
  OPERATIONS,
  PLATFORM,
  PIPELINE,
  SECURITY,
  SHIFT,
  STATS,
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

  it('renders the stat band with every value and label', () => {
    expect(html).toContain('class="stats');
    for (const stat of STATS) {
      expect(html).toContain(stat.value);
      expect(text).toContain(stat.label);
    }
  });

  it('renders the shift comparison with both columns of points', () => {
    for (const point of SHIFT.assistant.points) {
      expect(text).toContain(point);
    }
    for (const point of SHIFT.engine.points) {
      expect(text).toContain(point);
    }
  });

  it('renders the method section: spec-driven development as a standout with the self-healing trace', () => {
    expect(html).toContain('id="method"');
    expect(text).toContain(METHOD.kicker);
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
  });

  it('renders the security cards and the boundary flow diagram', () => {
    for (const card of SECURITY.cards) {
      expect(text).toContain(card.title);
      expect(text).toContain(card.body.slice(0, 50));
    }
    expect(text).toContain('Ephemeral container');
    // The gateway is named explicitly as the AI Gateway, with its controls.
    expect(text).toContain('Your AI Gateway');
    expect(text).toContain('guardrails');
    expect(text).toContain('DLP');
    expect(html).toContain('data-topic="security-compliance"');
    // The boundary also names what it makes structurally impossible, not just
    // the approved path (the negative space competitors never show).
    expect(html).toContain('denied-list');
    for (const denied of BOUNDARY_BLOCKED) {
      expect(text).toContain(denied);
    }
  });

  it('renders the operations section: infrastructure beyond code via zero-trust tunnels', () => {
    expect(html).toContain('id="operations"');
    expect(text).toContain(OPERATIONS.kicker);
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
    expect(text).toContain(CONTEXT.kicker);
    expect(text).toContain(CONTEXT.title);
    // The load-bearing capability: isolated-browser rendering distilled to markdown.
    expect(text).toContain('isolated browser');
    expect(text).toContain('markdown');
    expect(text).toContain('ingestion');
    for (const card of CONTEXT.cards) {
      expect(text).toContain(card.title);
      expect(text).toContain(card.body.slice(0, 40));
    }
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
    for (const layer of COST.layers) {
      expect(text).toContain(layer.body.slice(0, 40));
    }
    // The attribution ledger: every line carries an owner, and the closing
    // total reads zero unattributed (the load-bearing cost claim).
    expect(html).toContain('ledger-totals');
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
