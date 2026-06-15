// REQ-SETUP-010: Social-share preview metadata on the public landing page.
//
// Behavioural — parses index.html through jsdom (the same HTML parser
// Twitter/Facebook/LinkedIn scrapers use) and queries via CSS selectors
// for each meta tag the spec requires. Tests fail if a scraper would
// see the wrong preview, not if a regex stops matching a string in the
// source file.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Types for jsdom come from web-ui/src/types/jsdom.d.ts (local
// declaration — @types/jsdom is not in devDeps for the sake of one
// consumer).
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));

let doc: Document;
beforeAll(() => {
  const html = readFileSync(
    resolve(__dirname, '../../index.html'),
    'utf8'
  );
  doc = new JSDOM(html).window.document;
});

function ogContent(property: string): string | null {
  const el = doc.querySelector(`meta[property="${property}"]`);
  return el ? el.getAttribute('content') : null;
}

function nameContent(name: string): string | null {
  const el = doc.querySelector(`meta[name="${name}"]`);
  return el ? el.getAttribute('content') : null;
}

describe('REQ-SETUP-010: Social-share preview metadata on the public landing page', () => {
  describe('AC1: Open Graph metadata is exposed (scraper view)', () => {
    const required: Array<[string, RegExp]> = [
      ['og:type', /^website$/],
      ['og:site_name', /^Codeflare$/],
      ['og:title', /Codeflare/],
      ['og:description', /^.+$/],
      ['og:url', /^https:\/\//],
      ['og:image', /^https:\/\/.+\.(png|jpg|jpeg|webp)$/i],
      ['og:image:width', /^1200$/],
      ['og:image:height', /^630$/],
      ['og:image:alt', /^.+$/],
      ['og:locale', /^[a-z]{2}_[A-Z]{2}$/],
    ];
    for (const [prop, pattern] of required) {
      it(`a scraper resolves <meta property="${prop}"> with content matching ${pattern}`, () => {
        const val = ogContent(prop);
        expect(val, `scraper would not find og: tag "${prop}"`).not.toBeNull();
        expect(val).toMatch(pattern);
      });
    }
  });

  describe('AC2: Twitter Card metadata is set (scraper view)', () => {
    it('twitter:card resolves to summary_large_image', () => {
      expect(nameContent('twitter:card')).toBe('summary_large_image');
    });
    it('twitter:title resolves to a Codeflare brand string', () => {
      expect(nameContent('twitter:title')).toMatch(/Codeflare/);
    });
    it('twitter:description resolves to non-trivial copy', () => {
      const v = nameContent('twitter:description');
      expect(v).not.toBeNull();
      expect(v!.length).toBeGreaterThan(10);
    });
    it('twitter:image resolves to an https URL', () => {
      expect(nameContent('twitter:image')).toMatch(/^https:\/\//);
    });
    it('twitter:image:alt resolves to non-empty alt text', () => {
      const v = nameContent('twitter:image:alt');
      expect(v).not.toBeNull();
      expect(v!.length).toBeGreaterThan(0);
    });
  });

  describe('AC3: 1200x630 PNG preview image is referenced (parsed values)', () => {
    it('og:image is a PNG (per AC: 1200x630 PNG)', () => {
      expect(ogContent('og:image')).toMatch(/\.png$/i);
    });
    it('og:image:width parses to exactly 1200', () => {
      expect(Number(ogContent('og:image:width'))).toBe(1200);
    });
    it('og:image:height parses to exactly 630', () => {
      expect(Number(ogContent('og:image:height'))).toBe(630);
    });
  });

  describe('AC4: description and og:description stay in sync (scraper consistency)', () => {
    it('<meta name="description"> and <meta property="og:description"> share canonical copy', () => {
      const desc = nameContent('description');
      const og = ogContent('og:description');
      expect(desc, '<meta name="description"> missing').not.toBeNull();
      expect(og, '<meta property="og:description"> missing').not.toBeNull();
      // AC4: the og:description is the canonical short copy. The long
      // SEO description may extend it; substring containment in either
      // direction proves the two are in sync.
      expect(desc!.includes(og!) || og!.includes(desc!)).toBe(true);
    });
  });

});
