import { describe, it, expect } from 'vitest';
import { buildRobotsTxt, buildSitemapXml, buildLlmsTxt, CANONICAL_ORIGIN } from '../../lib/seo';

describe('SEO discoverability documents (REQ-LANDING-003)', () => {
  describe('buildRobotsTxt', () => {
    it('advertises the marketing surface + sitemap in public mode, but excludes app/api/auth/login/setup', () => {
      const robots = buildRobotsTxt(true);
      expect(robots).toContain('User-agent: *');
      expect(robots).toContain('Allow: /');
      expect(robots).toContain(`Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`);
      // The private surfaces stay out of the index even on a public deployment.
      expect(robots).toContain('Disallow: /app/');
      expect(robots).toContain('Disallow: /api/');
      expect(robots).toContain('Disallow: /login');
      expect(robots).toContain('Disallow: /setup');
    });

    it('disallows all crawling and omits the sitemap in private mode', () => {
      const robots = buildRobotsTxt(false);
      expect(robots).toBe('User-agent: *\nDisallow: /\n');
      expect(robots).not.toContain('Sitemap:');
      expect(robots).not.toContain('Allow:');
    });
  });

  describe('buildSitemapXml', () => {
    it('is a valid urlset listing the indexable routes at the canonical origin', () => {
      const xml = buildSitemapXml();
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      expect(xml).toContain(`<loc>${CANONICAL_ORIGIN}/</loc>`);
      expect(xml).toContain(`<loc>${CANONICAL_ORIGIN}/landing/privacy/</loc>`);
      // The noindex login page must never appear in the sitemap.
      expect(xml).not.toContain('/login');
    });
  });

  describe('buildLlmsTxt', () => {
    it('follows the llms.txt convention: H1 title, a summary blockquote, and linked sections', () => {
      const llms = buildLlmsTxt();
      expect(llms.startsWith('# Codeflare')).toBe(true);
      expect(llms).toMatch(/\n> .+/); // a summary blockquote exists (llms.txt convention), without pinning its copy
      expect(llms).toContain(`(${CANONICAL_ORIGIN}/)`);
      expect(llms).toContain('https://github.com/nikolanovoselec/codeflare');
      expect(llms).toContain('## Contact');
    });

    it('contains no em-dash or en-dash (the landing copy tripwire applies to served prose)', () => {
      expect(buildLlmsTxt()).not.toMatch(/[–—]/);
    });
  });
});
