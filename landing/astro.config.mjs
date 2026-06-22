import { defineConfig } from 'astro/config';

// The landing page is served by the Worker at "/" for unauthenticated
// visitors (SaaS + onboarding modes). It builds into web-ui/dist/landing so
// the existing [assets] binding picks it up — no wrangler.toml changes. The
// base path keeps every generated asset URL under /landing/* where the asset
// layer can resolve it regardless of which path the document was served on.
export default defineConfig({
  site: 'https://codeflare.ch',
  base: '/landing',
  outDir: '../web-ui/dist/landing',
  build: {
    assets: '_astro',
    // Inline the bundled CSS into each document instead of emitting a
    // render-blocking <link rel="stylesheet">. A render-blocking external
    // stylesheet blocks the ENTIRE first paint - including the inline dark-canvas
    // <style> - so during a full-page landing <-> /login navigation the new
    // document stays unpainted until that CSS downloads. Chrome holds the prior
    // page across that window (paint-holding), but some Chromium forks
    // (Vivaldi/Arc/Brave) instead expose a gray navigation canvas for its whole
    // duration. Inlining makes first paint happen on HTML parse, collapsing that
    // gap. The inline <style> is authorized by the hash-based CSP below.
    inlineStylesheets: 'always',
  },
  // Hash-based Content Security Policy (REQ-SEC-008; same shape as graymatter.ch).
  // Astro injects a per-page <meta http-equiv="content-security-policy"> with a
  // SHA-256 hash for every <style>/<script> ELEMENT it emits, so the inlined
  // stylesheet and the dark first-paint <style> are authorized by hash rather
  // than a blanket style-src 'unsafe-inline'. The Worker still sends its own CSP
  // header (src/index.ts); browsers enforce BOTH, so the meta's hashes block any
  // injected inline <style> even though the header keeps a now-redundant
  // 'unsafe-inline'. The animated components use DYNAMIC inline style="--i:N"
  // attributes whose values vary per item and cannot be hashed, so style-src-attr
  // keeps 'unsafe-inline' for ATTRIBUTES only (low blast radius - attribute styles
  // cannot load resources). All scripts are external ('self' + Turnstile + CF
  // insights); the application/json + ld+json blocks are non-executable. Directives
  // mirror the Worker header so the meta is no stricter except the intended
  // style-element tightening. frame-ancestors cannot live in a meta CSP, so
  // clickjacking stays covered by the Worker's X-Frame-Options: DENY.
  security: {
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'self'",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' wss: https://cloudflareinsights.com",
        "img-src 'self' data: https://www.gravatar.com",
        "frame-src https://challenges.cloudflare.com",
        "style-src-attr 'unsafe-inline'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      scriptDirective: {
        resources: ["'self'", "https://challenges.cloudflare.com", "https://static.cloudflareinsights.com"],
      },
      styleDirective: {
        resources: ["'self'", "https://fonts.googleapis.com"],
      },
    },
  },
  // The Worker serves landing documents under a strict CSP with no
  // 'unsafe-inline' for scripts and no script/style nonces (src/index.ts). Astro
  // otherwise inlines any bundled script (and small font/asset) below ~4 KB
  // straight into the HTML, which that CSP then refuses to execute - silently
  // killing the hero scramble and the contact controller, and blocking the
  // inlined font. assetsInlineLimit: 0 forces every script, font, and asset out
  // to an external /landing/_astro/* file served from 'self', which the CSP
  // allows. (CSS is exempt: it is inlined above and hash-authorized.)
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
  },
});
