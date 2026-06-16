/**
 * Discoverability documents for the public marketing surface: robots.txt,
 * sitemap.xml, and llms.txt, served at the deployment root by the Worker
 * (src/index.ts) and gated on the public landing being active (SaaS or
 * onboarding mode). Default and enterprise deployments are private apps, so
 * their robots.txt disallows all crawling and they expose no sitemap or llms
 * manifest. Pure string builders so the content is unit-testable; the Worker
 * only wires them to routes and sets the content types.
 */

/**
 * The canonical public origin for the marketing site. Matches the hardcoded
 * canonical in the landing BaseLayout (REQ-LANDING-003) so the sitemap URLs and
 * the indexable host never disagree, even when the page is served from another
 * domain (an integration host should not advertise itself as canonical).
 */
export const CANONICAL_ORIGIN = 'https://codeflare.ch';

/**
 * Indexable marketing routes. The login page is intentionally noindex (it
 * carries auth ?status / ?error params), so it is omitted. Privacy is served
 * from the landing asset path, matching its own canonical.
 */
const SITEMAP_PATHS = ['/', '/landing/privacy/'];

/** robots.txt body. Public mode allows crawling of the marketing surface (but
 *  not the app, API, auth, login, or setup paths) and points at the sitemap;
 *  private mode disallows everything. */
export function buildRobotsTxt(publicMode: boolean): string {
  if (!publicMode) {
    return 'User-agent: *\nDisallow: /\n';
  }
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /app/',
    'Disallow: /api/',
    'Disallow: /auth/',
    'Disallow: /login',
    'Disallow: /setup',
    '',
    `Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
}

/** sitemap.xml body listing the indexable marketing routes at the canonical origin. */
export function buildSitemapXml(): string {
  const urls = SITEMAP_PATHS.map((p) => `  <url><loc>${CANONICAL_ORIGIN}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** llms.txt body (llmstxt.org convention): an H1 title, a one-paragraph summary
 *  blockquote, context, then linked sections, so an LLM can ground itself on
 *  what Codeflare is and where to look without crawling the rendered page. */
export function buildLlmsTxt(): string {
  return `# Codeflare

> Codeflare is the enterprise agentic engine: autonomous coding agents that build, review, test, and ship inside your own cloud boundary, governed, attributed, and encrypted. It is not a coding assistant. The engineer specifies, steers, and judges; the agents do everything else, subject to your git, your CI, and your zero-trust boundary.

Codeflare runs spec-driven development (SDD) and test-driven development (TDD) as enforced, self-healing loops: every change is checked against its specification and acceptance criteria at the pull-request boundary, drift is a blocking finding, and a parallel board of specialist review agents converges on a single human triage gate. Agents read the open web through a throwaway isolated browser (heavy pages distilled to clean markdown), every model call is inspected at your AI Gateway with guardrails and DLP, and every token of spend is attributed. Codeflare Enterprise deploys into the customer's own cloud account, where their identity provider and access policies govern who can do what.

## Product
- [Codeflare](${CANONICAL_ORIGIN}/): The enterprise agentic engine, its zero-trust security model, and how one governed run moves from intent to merge.
- [Privacy](${CANONICAL_ORIGIN}/landing/privacy/): How the demo-request contact form handles data (relayed as email, never stored).

## Source
- [Codeflare on GitHub](https://github.com/nikolanovoselec/codeflare): Public repository. This landing page is itself a Codeflare-governed requirement (REQ-LANDING-001).

## Contact
- [Request a demo](${CANONICAL_ORIGIN}/#contact): Enterprise deployment starts with a conversation; the engine deploys into your own cloud account where your IdP and access policies are configured.
`;
}
