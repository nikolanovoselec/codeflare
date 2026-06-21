/**
 * Structural / behavioural tests for the composed onboarding login page
 * (REQ-AUTH-020 / REQ-AUTH-021). The page is now Header + LoginCard (+ SsoAccordion +
 * RequestedPanel) + Footer; these tests render it through the Container API and
 * assert the wiring that matters — the GitHub OAuth entry, the SSO buttons being
 * CTAs (never real auth routes), the hidden-by-default confirmation, the
 * parseable error map, and search exclusion — not copy strings.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import LoginPage from '../pages/login.astro';
import { LOGIN } from '../content/site';
import { documentDom, dom, decodeEntities } from './_helpers/dom';

let html: string;
let body: HTMLElement;
let documentNode: Document;
let text: string;

beforeAll(async () => {
  const container = await AstroContainer.create();
  html = await container.renderToString(LoginPage);
  body = dom(html);
  documentNode = documentDom(html);
  text = decodeEntities(html);
});

describe('onboarding login page (REQ-AUTH-020 / REQ-AUTH-021)', () => {
  it('GitHub is the single primary action and links to the OAuth entry route', () => {
    const gh = body.querySelector('.login-github')!;
    expect(gh).not.toBeNull();
    expect(gh.getAttribute('href')).toBe(LOGIN.github.href);
    expect(LOGIN.github.href).toBe('/auth/github/login');
    expect(gh.classList.contains('btn-primary')).toBe(true);
  });

  it('renders one native exclusive <details name="sso"> accordion item per configured provider', () => {
    const items = Array.from(body.querySelectorAll('details.sso-item'));
    expect(items).toHaveLength(LOGIN.ssoProviders.length);
    for (const item of items) expect(item.getAttribute('name')).toBe('sso');
    const ids = Array.from(body.querySelectorAll('[data-sso]')).map((e) => e.getAttribute('data-sso'));
    for (const provider of LOGIN.ssoProviders) expect(ids).toContain(provider.id);
  });

  it('every SSO button is a CTA deep-linking to the contact form, never a real auth route', () => {
    const ctas = Array.from(body.querySelectorAll('a[data-topic="enterprise-deployment"]'));
    expect(ctas).toHaveLength(LOGIN.ssoProviders.length);
    for (const cta of ctas) expect(cta.getAttribute('href')).toBe(LOGIN.sso.cta.href);
    expect(LOGIN.sso.cta.href).toContain('#contact');
    expect(LOGIN.sso.cta.href).toContain('topic=enterprise-deployment');
    // None of the SSO buttons may point at a real auth route.
    expect(html).not.toMatch(/data-sso="[^"]+"[^>]*href="\/auth\//);
  });

  it('ships the access-requested confirmation hidden, with the sign-in choices visible by default', () => {
    const requested = body.querySelector('[data-login-requested]')!;
    expect(requested).not.toBeNull();
    expect(requested.hasAttribute('hidden')).toBe(true);
    const choices = body.querySelector('[data-login-choices]')!;
    expect(choices).not.toBeNull();
    expect(choices.hasAttribute('hidden')).toBe(false);
  });

  it('ships a hidden error slot and a parseable error map carrying the known codes', () => {
    expect(body.querySelector('[data-login-error]')?.hasAttribute('hidden')).toBe(true);
    const mapMatch = text.match(/<script type="application\/json" id="login-errors">([\s\S]*?)<\/script>/);
    expect(mapMatch).not.toBeNull();
    const map = JSON.parse(mapMatch![1]) as Record<string, string>;
    expect(map['no-verified-email']).toBeTruthy();
    expect(map.default).toBeTruthy();
  });

  it('inherits the shared nav and font preloads while omitting landing-only motion hooks', () => {
    expect(body.querySelector('.login-back')?.getAttribute('href')).toBe(LOGIN.back.href);
    const preloads = Array.from(documentNode.head.querySelectorAll('link[rel="preload"][as="font"]'));
    expect(preloads.map((link) => link.getAttribute('type'))).toEqual(['font/woff2', 'font/woff2']);
    expect(body.querySelector('[data-flare-fluid]')).toBeNull();
    expect(body.querySelector('[data-hero-kicker]')).toBeNull();
    expect(body.querySelector('[data-ft-loop]')).toBeNull();
    expect(body.querySelector('[data-agentfoot]')).toBeNull();
    expect(body.querySelector('[data-proof]')).toBeNull();
  });

  it('renders the same single shared ambient glow layer as the landing page', () => {
    // The glow is one BaseLayout-owned layer shared across pages, so /login carries
    // the identical treatment rather than its old bespoke .login-main background glow.
    expect(body.querySelectorAll('.page-ambient-glow')).toHaveLength(1);
  });

  it('is excluded from search indexing (auth URLs carry ?status / ?error)', () => {
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it('has no em-dash or en-dash anywhere in the rendered copy', () => {
    expect(text).not.toMatch(/[–—]/);
  });
});
