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
 * 'unsafe-inline') while keeping a scoped `style-src-attr 'unsafe-inline'`
 * for the dynamic `style="--i:N"` animation-stagger ATTRIBUTES.
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

  it('authorizes inline style ELEMENTS by an exact source set — no blanket unsafe-inline', () => {
    // Astro appends the per-element style hashes to this set at build. Exact
    // match (not arrayContaining) so a weakening ADDITION — a stray
    // 'unsafe-inline', a wildcard, a rogue origin — fails the test, not just a
    // removal. The only standing sources are 'self' and the Google Fonts
    // stylesheet origin; everything else is a build-generated hash.
    expect(csp.styleDirective.resources).toEqual(["'self'", 'https://fonts.googleapis.com']);
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

  it('keeps the unsafe-inline carve-out scoped to style ATTRIBUTES (dynamic --i:N stagger)', () => {
    const dirs = directiveMap(csp.directives);
    // style-src-attr governs ATTRIBUTES only; the dynamic per-item style="--i:N"
    // values cannot be hashed, so they need this scoped allowance. It must NOT
    // leak into style-src (elements stay hash-only).
    expect(dirs['style-src-attr']).toContain("'unsafe-inline'");
    expect(dirs['style-src']).toBeUndefined();
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
