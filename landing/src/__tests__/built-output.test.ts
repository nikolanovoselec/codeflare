import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { documentDom } from './_helpers/dom';
import { LOGIN } from '../content/site';

const output = fileURLToPath(new URL('../../../web-ui/dist/landing/', import.meta.url));

// Intentional generated-artifact contract: the actual static site remains
// readable without JavaScript and its externally served assets are complete.
describe('REQ-LANDING-016: dependency remediation preserves built static pages', () => {
  it.each(['index.html', 'login/index.html', 'privacy/index.html'])('REQ-LANDING-016: %s retains server-rendered content and complete self-hosted assets', (page) => {
    const document = documentDom(readFileSync(resolve(output, page), 'utf8'));
    expect(document.title.trim().length).toBeGreaterThan(0);
    expect(document.querySelectorAll('link[rel="stylesheet"][href]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('link[rel="preload"][as="font"][href]').length).toBeGreaterThan(0);
    const analyticsBeacon = 'https://static.cloudflareinsights.com/beacon.min.js';
    if (page !== 'privacy/index.html') {
      expect(Array.from(document.querySelectorAll('script[src]'))
        .some(script => script.getAttribute('src') !== analyticsBeacon)).toBe(true);
    }
    const assets = Array.from(document.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="preload"][as="font"][href]'));
    for (const asset of assets) {
      const href = asset.getAttribute('src') ?? asset.getAttribute('href');
      const url = new URL(href!, 'https://codeflare.ch');
      // BaseLayout's optional analytics beacon is not an application bundle.
      if (asset.tagName === 'SCRIPT' && href === analyticsBeacon) continue;
      expect(url.origin).toBe('https://codeflare.ch');
      expect(url.pathname.startsWith('/landing/_astro/')).toBe(true);
      expect(statSync(resolve(output, decodeURIComponent(url.pathname.slice('/landing/'.length)))).size).toBeGreaterThan(0);
    }
    document.querySelectorAll('script, style').forEach(node => node.remove());
    const main = document.querySelector('main');
    expect(main).not.toBeNull();
    expect(main!.textContent!.trim().length).toBeGreaterThan(0);
    expect(main!.querySelector('h1')).not.toBeNull();
    if (page === 'index.html') {
      // Public navigation/form and native trust-logo artifact contracts.
      expect(main!.querySelector('#contact form')).not.toBeNull();
      const logos = Array.from(main!.querySelectorAll('img[src]'))
        .map(image => new URL(image.getAttribute('src')!, 'https://codeflare.ch'))
        .filter(url => url.pathname.startsWith('/landing/customers/'));
      expect(logos.length).toBeGreaterThan(0);
      for (const url of logos) {
        expect(statSync(resolve(output, decodeURIComponent(url.pathname.slice('/landing/'.length)))).size).toBeGreaterThan(0);
      }
    } else if (page === 'login/index.html') {
      expect(Array.from(main!.querySelectorAll('a[href]')).some(link => link.getAttribute('href') === LOGIN.github.href)).toBe(true);
      expect(main!.querySelector('p')).not.toBeNull();
    } else {
      expect(main!.querySelector('article h2')).not.toBeNull();
      expect(main!.querySelector('article p')).not.toBeNull();
    }
  });
});
