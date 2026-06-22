/**
 * Build + CSP contract tests for the landing config (REQ-LANDING-004 AC3,
 * REQ-SEC-008 AC8).
 *
 * The gray-flash fix and the hash-based meta CSP both live in
 * `astro.config.mjs`: `build.inlineStylesheets: 'always'` collapses the
 * inter-document navigation gap by removing the render-blocking external
 * stylesheet, and `security.csp` makes Astro inject a per-page
 * `<meta http-equiv="content-security-policy">` that authorizes inline
 * <style>/<script> ELEMENTS by SHA-256 hash (no blanket style-src
 * 'unsafe-inline'). The dynamic `style="--i:N"` animation-stagger ATTRIBUTES
 * are build-static (SSG) and hashed too; `'unsafe-hashes'` in styleDirective is
 * what lets those hashed style ATTRIBUTES apply. (Astro's schema forbids a
 * style-src* directive in the raw `directives` array, so the carve-out lives in
 * styleDirective.)
 *
 * Those two settings are emitted only by a full `astro build`, which the
 * Container API used by the other landing tests does NOT run, and which
 * cannot be run locally (resource constraint). So these tests assert the
 * build/security CONTRACT on the config object directly — the parsed values
 * that the build consumes. They fail if either setting is removed or
 * weakened. The actual injected meta + inlined CSS are verified post-deploy
 * via the browser console (no CSP violations, meta present, dark first paint).
 */
import { describe, it, expect } from 'vitest';
import config from '../../astro.config.mjs';

/** Parse a CSP directives array (["name a b", ...]) into name -> sources[]. */
function directiveMap(directives: string[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const entry of directives) {
    const [name, ...sources] = entry.trim().split(/\s+/);
    map[name] = sources;
  }
  return map;
}

describe('REQ-LANDING-004 AC3: stylesheet inlining collapses the inter-page paint gap', () => {
  it('inlines bundled CSS into every document instead of a render-blocking <link>', () => {
    // 'always' removes the external render-blocking stylesheet so first paint
    // happens on HTML parse — without it the Chromium-fork gray nav canvas
    // returns. 'auto' (Astro's default) would re-emit the <link> above the
    // inline threshold.
    expect(config.build?.inlineStylesheets).toBe('always');
  });

  it('forces scripts and fonts external so the no-unsafe-inline script CSP can run them', () => {
    expect(config.vite?.build?.assetsInlineLimit).toBe(0);
  });
});

describe('REQ-SEC-008 AC8: landing hash-based meta CSP', () => {
  const csp = config.security?.csp;

  it('enables a SHA-256 hash-based policy', () => {
    expect(csp).toBeTruthy();
    expect(csp.algorithm).toBe('SHA-256');
  });

  it('authorizes inline style ELEMENTS + hashed dynamic ATTRIBUTES — exact set, no blanket unsafe-inline', () => {
    // Astro appends the per-element AND per-attribute style hashes to this set at
    // build; 'unsafe-hashes' is what lets the hashed inline style="--i:N" ATTRIBUTES
    // apply (CSP3 requires it for style attributes even when their hash is present).
    // Exact match (not arrayContaining) so a weakening ADDITION — a stray
    // 'unsafe-inline', a wildcard, a rogue origin — fails the test, not just a
    // removal. NOTE: 'unsafe-hashes' is NOT 'unsafe-inline' — elements/attributes
    // stay restricted to their specific hashes.
    expect(csp.styleDirective.resources).toEqual([
      "'self'",
      'https://fonts.googleapis.com',
      "'unsafe-hashes'",
    ]);
    expect(csp.styleDirective.resources).not.toContain("'unsafe-inline'");
  });

  it('authorizes scripts by an exact external source set — no unsafe-inline / unsafe-eval', () => {
    // Exact match catches a weakening addition ('unsafe-inline', 'unsafe-eval',
    // a rogue origin) as well as the removal of a required script origin.
    expect(csp.scriptDirective.resources).toEqual([
      "'self'",
      'https://challenges.cloudflare.com',
      'https://static.cloudflareinsights.com',
    ]);
  });

  it('places no style-src* / script-src directive in the raw directives array (Astro schema rejects them)', () => {
    // Astro's security.csp schema FORBIDS style-src, style-src-attr, style-src-elem,
    // script-src (etc.) inside `directives` — they must be configured via
    // styleDirective/scriptDirective so Astro can inject hashes. A style-src* entry
    // here throws a ZodError at config load and fails every landing test at startup;
    // this guards that regression.
    const dirs = directiveMap(csp.directives);
    expect(dirs['style-src']).toBeUndefined();
    expect(dirs['style-src-attr']).toBeUndefined();
    expect(dirs['style-src-elem']).toBeUndefined();
    expect(dirs['script-src']).toBeUndefined();
  });

  it('mirrors the Worker header sources so the AND-enforced meta blocks nothing legitimate', () => {
    const dirs = directiveMap(csp.directives);
    expect(dirs['default-src']).toEqual(["'self'"]);
    expect(dirs['frame-src']).toContain('https://challenges.cloudflare.com');
    expect(dirs['connect-src']).toEqual(
      expect.arrayContaining(["'self'", 'wss:', 'https://cloudflareinsights.com']),
    );
    expect(dirs['img-src']).toEqual(
      expect.arrayContaining(["'self'", 'data:', 'https://www.gravatar.com']),
    );
    expect(dirs['font-src']).toEqual(
      expect.arrayContaining(["'self'", 'https://fonts.gstatic.com']),
    );
  });

  it('omits frame-ancestors from the meta CSP (delegated to the Worker X-Frame-Options)', () => {
    // frame-ancestors is ignored in a <meta> CSP, so clickjacking stays the
    // Worker header's job; asserting absence documents the deliberate split.
    const dirs = directiveMap(csp.directives);
    expect(dirs['frame-ancestors']).toBeUndefined();
  });
});
