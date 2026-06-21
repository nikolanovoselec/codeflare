/**
 * External-metadata contract tests for the landing page (REQ-LANDING-003).
 *
 * BaseLayout.astro carries the canonical SEO / social / structured-data metadata
 * for the enterprise positioning. These tests render the home page through the
 * Astro Container API and parse the FULL rendered document (head included) via
 * documentDom, then assert the metadata CONTRACT: which tags exist, their fixed
 * contract values (og:type, og:site_name, twitter:card, JSON-LD @type), and that
 * copy-bearing tags carry non-empty content (without pinning the prose itself).
 *
 * Each test fails if the corresponding tags are removed from BaseLayout's <head>.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import IndexPage from '../pages/index.astro';
import { documentDom } from './_helpers/dom';

let doc: Document;

beforeAll(async () => {
  const container = await AstroContainer.create();
  const html = await container.renderToString(IndexPage);
  doc = documentDom(html);
});

describe('REQ-LANDING-003: external metadata (SEO, social, structured data)', () => {
  it('REQ-LANDING-003 AC1: emits the Open Graph meta tags with their contract values', () => {
    // Fixed-value OG tags (contract, not copy).
    const ogType = doc.querySelector('meta[property="og:type"]');
    expect(ogType, 'og:type meta exists').not.toBeNull();
    expect(ogType!.getAttribute('content')).toBe('website');

    const ogSiteName = doc.querySelector('meta[property="og:site_name"]');
    expect(ogSiteName, 'og:site_name meta exists').not.toBeNull();
    expect(ogSiteName!.getAttribute('content')).toBe('Codeflare');

    const ogImage = doc.querySelector('meta[property="og:image"]');
    expect(ogImage, 'og:image meta exists').not.toBeNull();
    expect(ogImage!.getAttribute('content')).toBe('https://codeflare.ch/og.png');

    const ogUrl = doc.querySelector('meta[property="og:url"]');
    expect(ogUrl, 'og:url meta exists').not.toBeNull();
    expect(ogUrl!.getAttribute('content')).toBe('https://codeflare.ch/');

    // Copy-bearing OG tags: assert presence + non-empty content, not the prose.
    for (const prop of ['og:title', 'og:description']) {
      const tag = doc.querySelector(`meta[property="${prop}"]`);
      expect(tag, `${prop} meta exists`).not.toBeNull();
      expect((tag!.getAttribute('content') ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('REQ-LANDING-003 AC2: emits the Twitter Card meta tags', () => {
    const card = doc.querySelector('meta[name="twitter:card"]');
    expect(card, 'twitter:card meta exists').not.toBeNull();
    expect(card!.getAttribute('content')).toBe('summary_large_image');

    const image = doc.querySelector('meta[name="twitter:image"]');
    expect(image, 'twitter:image meta exists').not.toBeNull();
    expect(image!.getAttribute('content')).toBe('https://codeflare.ch/og.png');

    // Copy-bearing Twitter tags: presence + non-empty content only.
    for (const name of ['twitter:title', 'twitter:description']) {
      const tag = doc.querySelector(`meta[name="${name}"]`);
      expect(tag, `${name} meta exists`).not.toBeNull();
      expect((tag!.getAttribute('content') ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('REQ-LANDING-003 AC3: emits a canonical link with a non-empty href', () => {
    const canonical = doc.querySelector('link[rel="canonical"]');
    expect(canonical, 'canonical link exists').not.toBeNull();
    const href = canonical!.getAttribute('href') ?? '';
    expect(href.trim().length).toBeGreaterThan(0);
    expect(href).toBe('https://codeflare.ch/');
  });

  it('REQ-LANDING-003 AC4: emits a meta description with non-empty content', () => {
    const desc = doc.querySelector('meta[name="description"]');
    expect(desc, 'meta description exists').not.toBeNull();
    expect((desc!.getAttribute('content') ?? '').trim().length).toBeGreaterThan(0);
  });

  it('REQ-LANDING-003 AC5: emits a JSON-LD block that parses to a schema.org @graph', () => {
    const script = doc.querySelector('script[type="application/ld+json"]');
    expect(script, 'JSON-LD script exists').not.toBeNull();

    const parsed = JSON.parse(script!.textContent ?? '');
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
    expect(parsed['@context']).toBe('https://schema.org');

    expect(Array.isArray(parsed['@graph'])).toBe(true);
    const types = parsed['@graph'].map((node: { '@type'?: string }) => node['@type']);
    expect(types).toContain('Organization');
    expect(types).toContain('WebSite');
  });

  it('REQ-LANDING-003 AC7: emits theme-color meta and an apple-touch-icon link', () => {
    const themeColor = doc.querySelector('meta[name="theme-color"]');
    expect(themeColor, 'theme-color meta exists').not.toBeNull();
    expect(themeColor!.getAttribute('content')).toBe('#0a0a0c');

    const appleIcon = doc.querySelector('link[rel="apple-touch-icon"]');
    expect(appleIcon, 'apple-touch-icon link exists').not.toBeNull();
    expect((appleIcon!.getAttribute('href') ?? '').trim().length).toBeGreaterThan(0);
  });
});
