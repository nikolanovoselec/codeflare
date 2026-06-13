import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import LoginPage from '../pages/login.astro';
import { LOGIN } from '../content/site';

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
  html = await container.renderToString(LoginPage);
  text = decodeEntities(html);
});

describe('onboarding login page (REQ-AUTH-020)', () => {
  it('GitHub is the single primary action and links to the OAuth entry route', () => {
    // The href is the load-bearing part: a wrong/empty href is a dead sign-in
    // button. Assert the exact OAuth entry route, not just that "github" appears.
    expect(html).toContain(`href="${LOGIN.github.href}"`);
    expect(LOGIN.github.href).toBe('/auth/github/login');
    expect(text).toContain(LOGIN.github.label);
    // It is the one coral primary action.
    expect(html).toMatch(/class="[^"]*btn-primary[^"]*login-github|class="[^"]*login-github[^"]*btn-primary/);
  });

  it('renders exactly one enterprise SSO button per configured provider, each named', () => {
    // One <details data-sso> per provider — deleting a provider from site.ts drops
    // the count; this is a render assertion, not a string-presence tautology.
    const ssoButtons = [...html.matchAll(/data-sso="([^"]+)"/g)].map((m) => m[1]);
    expect(ssoButtons.length).toBe(LOGIN.ssoProviders.length);
    expect(ssoButtons.length).toBe(4);
    for (const provider of LOGIN.ssoProviders) {
      expect(ssoButtons).toContain(provider.id);
      expect(text).toContain(provider.name);
    }
  });

  it('every enterprise SSO button is a CTA that deep-links to the contact form with the enterprise topic', () => {
    // The buttons look real but must NOT start an OIDC flow — they expand to a
    // "get in touch" CTA pointing at the contact form, topic preselected. One CTA
    // link per provider.
    const ctas = [...html.matchAll(/data-topic="enterprise-deployment"/g)];
    expect(ctas.length).toBe(LOGIN.ssoProviders.length);
    expect(html).toContain(`href="${LOGIN.sso.cta.href}"`);
    expect(LOGIN.sso.cta.href).toContain('#contact');
    expect(LOGIN.sso.cta.href).toContain('topic=enterprise-deployment');
    // None of the SSO buttons may point at a real auth route.
    expect(html).not.toMatch(/data-sso="[^"]+"[^>]*href="\/auth\//);
  });

  it('uses a native exclusive <details name="sso"> accordion so it expands with no JS', () => {
    // The enterprise expand must work without JavaScript (brand principle: legible
    // and operable with no JS). The shared name makes it one-open-at-a-time natively.
    const grouped = [...html.matchAll(/<details[^>]*name="sso"/g)];
    expect(grouped.length).toBe(LOGIN.ssoProviders.length);
  });

  it('ships the not-approved confirmation panel, hidden by default (JS reveals it on ?status=requested)', () => {
    // The confirmation copy must be in the DOM (so login.ts can reveal it) but
    // hidden initially, since the default state is the sign-in choices.
    expect(text).toContain(LOGIN.requested.title);
    expect(text).toContain(LOGIN.requested.body);
    expect(html).toMatch(/data-login-requested[^>]*\bhidden\b/);
    // The choices block is present and NOT hidden by default (no-JS sees sign-in).
    expect(html).toContain('data-login-choices');
    expect(html).not.toMatch(/data-login-choices[^>]*\bhidden\b/);
  });

  it('ships a hidden error slot and the build-time error map for the ?error= path', () => {
    expect(html).toMatch(/data-login-error[^>]*\bhidden\b/);
    // The error map is rendered as parseable JSON the script reads; it must carry
    // the known codes and a default fallback.
    const mapMatch = text.match(/<script type="application\/json" id="login-errors">([\s\S]*?)<\/script>/);
    expect(mapMatch).not.toBeNull();
    const map = JSON.parse(mapMatch![1]) as Record<string, string>;
    expect(map['no-verified-email']).toBeTruthy();
    expect(map.default).toBeTruthy();
  });

  it('inherits the landing splash + design system so it flows from the marketing site', () => {
    // The flare-fluid mount-point comes from BaseLayout; its presence is what makes
    // the login share the marketing page's cursor splash (seamless flow requirement).
    expect(html).toContain('data-flare-fluid');
    // The card leads with the title (the redundant codeflare wordmarks were removed
    // for a cleaner page); the "Sign in to Codeflare" title carries the brand.
    expect(text).toContain(LOGIN.title);
  });

  it('is excluded from search indexing (auth URLs carry ?status / ?error)', () => {
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it('renders the helper line steering new visitors to GitHub, and a back link to the site', () => {
    expect(text).toContain(LOGIN.helper);
    expect(html).toContain(`href="${LOGIN.back.href}"`);
    expect(text).toContain(LOGIN.back.label);
  });

  it('has no em-dash or en-dash anywhere in the rendered copy', () => {
    expect(text).not.toMatch(/[–—]/);
  });
});
