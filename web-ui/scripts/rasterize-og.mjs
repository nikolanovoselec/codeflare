// Regenerates web-ui/public/og.png from og.svg. Run after editing og.svg.
// @resvg/resvg-js is a heavy native dep used only here, so it is NOT a committed
// devDependency — install it on demand from web-ui/:
//   npm install @resvg/resvg-js@2.6.2 --no-save --no-package-lock
//   node scripts/rasterize-og.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, '../public/og.svg');
const pngPath = resolve(here, '../public/og.png');

// og.svg references "JetBrains Mono" by name; resvg has no system fonts in CI,
// so the font files are committed under scripts/fonts and loaded explicitly.
// Without these the text silently drops out of the render.
const fontFiles = [
  resolve(here, 'fonts/JetBrainsMono-Regular.ttf'),
  resolve(here, 'fonts/JetBrainsMono-SemiBold.ttf'),
  resolve(here, 'fonts/JetBrainsMono-Bold.ttf'),
];

// The OG card is authored at 1200x630; render at 1200px width.
const svg = readFileSync(svgPath, 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  font: {
    loadSystemFonts: false,
    fontFiles,
    defaultFontFamily: 'JetBrains Mono',
  },
});
const png = resvg.render().asPng();
writeFileSync(pngPath, png);

console.log(`Wrote ${pngPath} (${png.length} bytes)`);
