import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import IndexPage from '../pages/index.astro';
import PrivacyPage from '../pages/privacy.astro';
import {
  CONTACT_FORM,
  FAQ_ITEMS,
  HERO,
  NAV_LINKS,
  PILLAR_SECTIONS,
  STATS,
  TERMINAL_TRANSCRIPT,
} from '../content/site';

let html: string;
/** Rendered HTML with Astro's entity escaping undone, for raw-copy assertions. */
let text: string;

function decodeEntities(rendered: string): string {
  return rendered
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

beforeAll(async () => {
  const container = await AstroContainer.create();
  html = await container.renderToString(IndexPage);
  text = decodeEntities(html);
});

describe('landing page (REQ-LANDING-001)', () => {
  it('renders the hero headline and positioning eyebrow', () => {
    expect(html).toContain('coding assistant.');
    expect(html).toContain('The Enterprise Agentic Coding Engine');
  });

  it('renders every content section with its anchor id', () => {
    for (const section of PILLAR_SECTIONS) {
      expect(html).toContain(`id="${section.id}"`);
    }
    expect(html).toContain('id="contact"');
    expect(html).toContain('id="faq"');
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

  it('renders every card of every pillar section', () => {
    for (const section of PILLAR_SECTIONS) {
      for (const card of section.cards ?? []) {
        expect(text).toContain(card.title);
      }
    }
  });

  it('renders the full terminal transcript statically for no-JS visitors', () => {
    for (const line of TERMINAL_TRANSCRIPT) {
      expect(html).toContain(`data-tt="${line.kind}"`);
    }
    const lineCount = (html.match(/data-tt=/g) ?? []).length;
    expect(lineCount).toBe(TERMINAL_TRANSCRIPT.length);
  });

  it('renders all stats strip entries', () => {
    for (const stat of STATS) {
      expect(html).toContain(stat.value);
    }
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
