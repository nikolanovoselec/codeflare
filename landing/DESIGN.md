# Design

Visual system for the Codeflare landing page. Source of truth for values is
`src/styles/tokens.css` (THE control panel) — this file documents intent so changes
stay on-brand. Structure follows the Stitch DESIGN.md format.

## Theme

Cinematic dark, one step deeper than the product app (`#050507` vs the app's
zinc-950) so the marketing surface reads as the "stage" the product performs on.
Light mode: none — the terminal register is dark by identity.

## Color Palette

| Role | Token | Value | Use |
|---|---|---|---|
| Background base | `--bg-base` | `#050507` | Page stage |
| Surface | `--bg-surface` | `#0d0d12` | Panels, alternating sections |
| Elevated | `--bg-elevated` | `#131318` | Inputs, raised chrome |
| Terminal | `--bg-terminal` | `#0a0a0f` | Terminal windows / snippets |
| Text primary | `--text-primary` | `#fafafa` | Headlines, key copy |
| Text secondary | `--text-secondary` | `#a1a1aa` | Body |
| Functional accent | `--accent` | `#3b82f6` | Links, focus — the product's blue |
| Flare orange | `--flare-orange` | `#ff6b35` | Gradient stop 1, energy |
| Flare pink | `--flare-pink` | `#f43f7c` | Gradient stop 2, cursor, prompt |
| Flare violet | `--flare-violet` | `#8b5cf6` | Gradient stop 3, glows |
| Terminal greens/yellows/cyans | `--term-*` | see tokens | Transcript tones |

**Strategy: Committed-dark.** The flare gradient is *energy under control*: it lives in
glows, borders, scene lighting, and the brand glyph — never as `background-clip: text`
(banned). Every color has an `-rgb` twin for alpha compositing.

**Reverse-video headline contrast:** the hero's flare line renders as solid
`--bg-base` (#050507) glyphs on the gradient panel — contrast ≈7.1:1 on
`--flare-orange`, ≈5.4:1 on `--flare-pink`, ≈4.7:1 on `--flare-violet`; AA at
every gradient stop, at any text size.

## Typography

- **Display / headings: JetBrains Mono Variable** — register-justified (the product is
  a terminal); this is identity, not the "technical = mono" costume.
- **Body: Inter Variable** — deliberately invisible; the mono carries the voice.
- Scale: fluid `clamp()` for display sizes; heading letter-spacing ≥ -0.045em;
  body line-height 1.65, max width ~65–75ch.
- `text-wrap: balance` on headings.

## Motion

Library: **Motion** (vanilla `motion` package — `animate`, `scroll`, `inView`,
springs). Principles (from PRODUCT.md principle 4 + Emil Kowalski's framework):

- Easing: strong ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`) for entrances; ease-in-out
  (`cubic-bezier(0.77, 0, 0.175, 1)`) for on-screen movement; springs for anything alive.
- UI interactions < 300ms; marketing choreography may run longer when it demonstrates
  product behavior.
- Only `transform`, `opacity`, `clip-path`, `filter` animate. No layout properties.
- Content is visible by default; JS sets initial hidden states *before* animating
  (no CSS-gated `opacity: 0` reveals — headless/no-JS renderers must see everything).
- `prefers-reduced-motion: reduce`: static transcript, no parallax/scroll-linking,
  opacity-only crossfades.

## Components

- **Terminal window** — the brand's hero artifact: gradient-border chrome (masked
  composite), traffic-light dots, toned transcript lines (`t-cmd/t-agent/t-ok/t-dim/t-warn`),
  typewriter player with pause/loop, static under reduced motion.
- **Section** — id + title + lead; eyebrows are being retired as section grammar.
- **Cards / grids** — being de-templated: each pillar gets a purpose-built layout
  rather than identical icon-card grids.
- **Contact form** — Turnstile-gated, posts to `/public/contact`; never stores.
- **Nav** — fixed, blurred, slide-down mobile panel, accessible toggle.

## Layout

- Max width `--max-width: 72rem`; sections breathe with `clamp()`-based vertical
  rhythm; single dominant idea per fold.
- Mobile-first: every component designed at 360px first, then enhanced.
- `z-index` scale: nav 50; nothing above it except dialogs (none yet).

## Bans (enforced by review)

Gradient text · side-stripe accent borders · uppercase tracked eyebrow on every
section · big-number stat strip template · identical icon-card grids · content
gated behind animation · raw color/font values outside `tokens.css`.
