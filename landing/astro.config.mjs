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
  },
  // The Worker serves landing documents under a strict CSP with no
  // 'unsafe-inline' and no script/style nonces (src/index.ts). Astro otherwise
  // inlines any bundled script (and small font/asset) below ~4 KB straight into
  // the HTML, which that CSP then refuses to execute — silently killing the
  // hero scramble and the contact controller, and blocking the inlined font.
  // assetsInlineLimit: 0 forces every script, font, and asset out to an
  // external /landing/_astro/* file served from 'self', which the CSP allows.
  vite: {
    build: {
      assetsInlineLimit: 0,
    },
  },
});
