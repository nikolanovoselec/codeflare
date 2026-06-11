import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import IndexPage from '../pages/index.astro';
import PrivacyPage from '../pages/privacy.astro';
import {
  BOUNDARY,
  CONTACT_FORM,
  COST,
  FAQ_ITEMS,
  FAQ_SECTION,
  FLEET_PANES,
  HERO,
  MAN_PAGE,
  NAV_LINKS,
  PILLAR_SECTIONS,
  REQUEST_COUNT,
  SESSION_END,
  SHIFT,
  STATS,
  TENANCY,
  TERMINAL_TRANSCRIPT,
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
  it('renders the hero headline with the reverse-video flare block (no gradient text)', () => {
    expect(html).toContain('coding assistant.');
    expect(html).toContain('flare-block');
    expect(text).toContain(HERO.motd);
  });

  it('renders every content section with its anchor id', () => {
    for (const section of PILLAR_SECTIONS) {
      expect(html).toContain(`id="${section.id}"`);
    }
    expect(html).toContain('id="contact"');
    expect(html).toContain('id="faq"');
    expect(html).toContain(`id="${SESSION_END.id}"`);
  });

  it('has a rendered target section for every nav anchor', () => {
    for (const link of NAV_LINKS) {
      const anchor = link.href.replace('#', '');
      expect(html).toContain(`id="${anchor}"`);
    }
  });

  it('renders an accessible mobile menu toggle wired to the nav link panel', () => {
    expect(html).toContain('aria-controls="nav-links"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="nav-links"');
    expect(html).toContain('data-open="false"');
  });

  it('renders a prompt-path label with readout for every section (eyebrows are gone)', () => {
    const sections = [SHIFT, ...PILLAR_SECTIONS, COST, TENANCY, FAQ_SECTION, CONTACT_FORM];
    for (const section of sections) {
      expect(text).toContain(section.prompt.line);
      expect(text).toContain(section.prompt.readout);
    }
    expect(html).not.toContain('class="eyebrow');
  });

  it('renders every pillar claim inside its artifact (ledger, man page, seed log, rail)', () => {
    for (const section of PILLAR_SECTIONS) {
      for (const card of section.cards ?? []) {
        expect(text).toContain(card.title);
        expect(text).toContain(card.body.slice(0, 60));
      }
    }
  });

  it('renders the full hero transcript statically for no-JS visitors', () => {
    for (const line of TERMINAL_TRANSCRIPT) {
      expect(html).toContain(`data-tt="${line.kind}"`);
    }
    const lineCount = (html.match(/data-tt=/g) ?? []).length;
    expect(lineCount).toBe(TERMINAL_TRANSCRIPT.length);
  });

  it('renders all fleet panes complete in static DOM (split needs no JS to be read)', () => {
    for (const pane of FLEET_PANES) {
      expect(text).toContain(pane.title);
      for (const line of pane.lines) {
        expect(text).toContain(line.text.trim());
      }
    }
    const fleetLines = (html.match(/data-fleet=/g) ?? []).length;
    expect(fleetLines).toBe(FLEET_PANES.reduce((sum, pane) => sum + pane.lines.length, 0));
  });

  it('renders the four boot assertions as the preflight ledger', () => {
    for (const stat of STATS) {
      expect(text).toContain(stat.key);
      expect(text).toContain(stat.label);
    }
    expect(html).not.toContain('class="stats');
  });

  it('renders the diff with every assistant/engine pair', () => {
    for (const point of SHIFT.assistant.points) {
      expect(text).toContain(point);
    }
    for (const point of SHIFT.engine.points) {
      expect(text).toContain(point);
    }
    const delCount = (html.match(/diff-del/g) ?? []).length;
    expect(delCount).toBe(SHIFT.assistant.points.length);
  });

  it('renders the boundary diagram with its prose twin and precise callouts', () => {
    expect(text).toContain('ephemeral container');
    expect(text).toContain(BOUNDARY.proseTwin.slice(0, 60));
    for (const callout of BOUNDARY.callouts) {
      expect(text).toContain(callout);
    }
  });

  it('renders the man page with the device row', () => {
    expect(text).toContain(MAN_PAGE.header);
    expect(text).toContain(MAN_PAGE.synopsis);
    for (const device of MAN_PAGE.devices) {
      expect(html).toContain(`device-${device}`);
    }
  });

  it('keeps every rendered count tied to the copy (count integrity)', () => {
    // The gateway request count appears in the transcript AND the cost reprise.
    const occurrences = (text.match(new RegExp(`${REQUEST_COUNT} requests`, 'g')) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(text).toContain(COST.reprise);
  });

  it('renders the destroy finale statically', () => {
    expect(text).toContain(SESSION_END.exit);
    for (const line of SESSION_END.lines) {
      expect(text).toContain(line);
    }
  });

  it('renders the status bar with the booted session state', () => {
    expect(html).toContain('id="statusbar"');
    expect(text).toContain('1 session · 1 engineer');
    expect(text).toContain('container:running');
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

  it('offers the security-brief micro-conversion preselecting the form topic', () => {
    expect(html).toContain('data-topic="security-compliance"');
  });

  it('links sign-in to the app and demo CTA to the contact section', () => {
    expect(html).toContain(`href="${HERO.secondaryCta.href}"`);
    expect(html).toContain('href="/app/"');
    expect(html).toContain('href="#contact"');
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
    expect(html).toContain('name="twitter:image"');
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
    // The load-bearing claim: submissions are relayed as email, not persisted
    expect(privacyHtml.toLowerCase()).toContain('not stored');
  });
});
