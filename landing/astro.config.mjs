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
});
