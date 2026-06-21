/**
 * Structural / behavioural tests for the composed landing page (REQ-LANDING-001).
 *
 * The page is now pure composition (Section / SectionHead / Terminal / Transcript
 * / GateSteps / FeatureGrid / ...). These tests render it through the Container
 * API and assert the STRUCTURE the composition must produce — section order, the
 * count and wiring of every terminal, the two animation stylers in place, grid
 * column counts, the live data hooks, and content invariants — rather than
 * matching copy strings. They double as the migration oracle: identical
 * structure proves the inline-to-component refactor preserved the page.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import IndexPage from '../pages/index.astro';
import PrivacyPage from '../pages/privacy.astro';
import { dom, decodeEntities, documentDom } from './_helpers/dom';
import { APP_LINKS } from '../config';
import {
  AGENTS,
  COST,
  DOGFOOD,
  EGRESS,
  FAQ_ITEMS,
  FEATURE_TERMINALS,
  HERO,
  METHOD,
  NAV_LINKS,
  ORCHESTRATION,
  PIPELINE,
  SECURITY,
  TERMINAL,
  TRUSTED,
} from '../content/site';

const SECTION_ORDER = [
  'shift',
  'method',
  'legacy',
  'security',
  'context',
  'pipeline',
  'orchestration',
  'cost',
  'platform',
  'mcp',
  'dogfood',
  'faq',
  'contact',
];

let html: string;
let body: HTMLElement;
let text: string;

beforeAll(async () => {
  const container = await AstroContainer.create();
  html = await container.renderToString(IndexPage);
  body = dom(html);
  text = decodeEntities(html);
});

describe('landing page composition (REQ-LANDING-001)', () => {
  it('server-renders the flare visual mode when the flare field exists', () => {
    expect(html).toMatch(/<html[^>]*class="flare-on"/);
    expect(html).toMatch(/<div class="flare-field"[^>]*data-flare-fluid/);
  });

  it('renders exactly one shared ambient glow layer and no legacy per-hero glow', () => {
    // The glow is now a single fixed layer owned by BaseLayout (shared with /login),
    // not the old absolutely-positioned .hero-glow element inside the hero.
    expect(body.querySelectorAll('.page-ambient-glow')).toHaveLength(1);
    expect(body.querySelector('.hero-glow')).toBeNull();
  });

  it('omits the Cloudflare Web Analytics beacon when no PUBLIC_CF_BEACON_TOKEN is configured', () => {
    const doc = documentDom(html);
    expect(
      doc.querySelector('script[src="https://static.cloudflareinsights.com/beacon.min.js"]'),
    ).toBeNull();
  });

  it('emits the Web Analytics beacon carrying the configured token when PUBLIC_CF_BEACON_TOKEN is set', async () => {
    vi.stubEnv('PUBLIC_CF_BEACON_TOKEN', 'tok_test_123');
    try {
      const container = await AstroContainer.create();
      const withToken = await container.renderToString(IndexPage);
      const doc = documentDom(withToken);
      const beacon = doc.querySelector(
        'script[src="https://static.cloudflareinsights.com/beacon.min.js"]',
      );
      expect(beacon).not.toBeNull();
      expect(beacon!.hasAttribute('defer')).toBe(true);
      const cfg = JSON.parse(beacon!.getAttribute('data-cf-beacon')!) as { token: string };
      expect(cfg.token).toBe('tok_test_123');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('renders every top-level section, in order, via <Section>', () => {
    const ids = Array.from(body.querySelectorAll('main > section')).map((s) => s.id);
    expect(ids).toEqual(SECTION_ORDER);
  });

  it('opens every section with a <SectionHead> (kicker + heading)', () => {
    for (const section of Array.from(body.querySelectorAll('main > section'))) {
      const head = section.querySelector('.section-head');
      expect(head, `#${section.id} has a section head`).not.toBeNull();
      expect(head!.querySelector('.kicker'), `#${section.id} head has a kicker`).not.toBeNull();
      expect(
        section.querySelector('.section-head:not(.substation) h2'),
        `#${section.id} has a top-level h2`
      ).not.toBeNull();
    }
  });

  it('renders exactly four folded substations (operations, e2e, tenancy, runs-everywhere)', () => {
    expect(body.querySelectorAll('.section-head.substation')).toHaveLength(4);
    for (const sub of Array.from(body.querySelectorAll('.section-head.substation'))) {
      expect(sub.querySelector('h3')).not.toBeNull();
      expect(sub.querySelector('h2')).toBeNull();
    }
  });

  it('renders the full set of terminals, each armed for the proof reveal', () => {
    // hero + 4 feature + method gate + legacy + boundary + 2 context + board +
    // orch + ledger + platform seed + mcp + dogfood = 16.
    expect(body.querySelectorAll('.terminal[data-proof]')).toHaveLength(16);
  });
});

describe('hero top line (capability ticker)', () => {
  it('is the first hero-copy element and keeps the headline directly below it', () => {
    const heroCopy = body.querySelector('.hero-copy')!;
    const children = Array.from(heroCopy.children);
    expect(children[0].hasAttribute('data-hero-kicker')).toBe(true);
    expect(children[1].classList.contains('hero-headline')).toBe(true);
  });

  it('renders the rotating capability words as one data-driven stack', () => {
    const ticker = body.querySelector('[data-hero-kicker]')!;
    const words = ticker.querySelectorAll('[data-hero-kicker-word]');
    expect(words).toHaveLength(HERO.kicker.words.length);
    expect(words[0].getAttribute('data-active')).toBe('true');
    expect(Array.from(words).map((word) => word.textContent?.trim())).toEqual(HERO.kicker.words);
  });
});

describe('hero terminal (the reel, looping)', () => {
  it('carries the full run array on data-ft-loop and shuffles, with no play-once (it loops)', () => {
    const hero = body.querySelector('.hero-terminal .terminal')!;
    expect(JSON.parse(hero.getAttribute('data-ft-loop')!)).toEqual(TERMINAL.run);
    expect(hero.hasAttribute('data-ft-shuffle')).toBe(true);
    // #39: the reel loops now; data-ft-once would stop it on the last beat.
    expect(hero.hasAttribute('data-ft-once')).toBe(false);
  });

  it('renders the typed command slot resting on run[0] and the animated statusline foot', () => {
    const hero = body.querySelector('.hero-terminal .terminal')!;
    expect(hero.querySelector('.ft-typed[data-ft-typed]')?.textContent).toBe(TERMINAL.run[0]);
    expect(hero.querySelector('.terminal-foot[data-agentfoot] [data-tf-ctx]')).not.toBeNull();
    expect(hero.querySelector('.terminal-foot[data-agentfoot] [data-tf-reason]')).not.toBeNull();
  });

  it('opts the marketing page into the scramble, fluid, and proof client hooks', () => {
    expect(body.querySelector('[data-flare-fluid]')).not.toBeNull();
    expect(body.querySelector('.hero-headline .flare[data-scramble]')).not.toBeNull();
    expect(body.querySelector('.terminal[data-proof]')).not.toBeNull();
    expect(body.querySelector('[data-agentfoot]')).not.toBeNull();
  });
});

describe('feature terminals (the shift)', () => {
  it('renders one looping feature terminal per item, each with its command loop and a typed slot', () => {
    const fts = body.querySelectorAll('.feature-terminal');
    expect(fts).toHaveLength(FEATURE_TERMINALS.length);
    fts.forEach((ft, i) => {
      expect(JSON.parse(ft.getAttribute('data-ft-loop')!)).toEqual(FEATURE_TERMINALS[i].loop);
      expect(ft.querySelector('.ft-typed[data-ft-typed]')).not.toBeNull();
      // Feature terminals loop (no play-once marker).
      expect(ft.hasAttribute('data-ft-once')).toBe(false);
    });
  });
});

describe('proof terminals type their last line in on view (#32)', () => {
  it('every proof transcript ends with one caret and a [data-typeline] last line', () => {
    const proofs = body.querySelectorAll('.proof-terminal');
    expect(proofs).toHaveLength(3); // legacy + context web + context e2e
    for (const p of Array.from(proofs)) {
      const lines = p.querySelectorAll('.terminal-body .t-line');
      expect(p.querySelectorAll('.terminal-body .t-caret')).toHaveLength(1);
      const last = lines[lines.length - 1];
      expect(last.querySelector('.t-caret')).not.toBeNull();
      // The last line's text is wrapped for type-on-view.ts; no earlier line is.
      expect(p.querySelectorAll('.terminal-body [data-typeline]')).toHaveLength(1);
      expect(last.querySelector('[data-typeline]')).not.toBeNull();
    }
  });
});

describe('rolling-row artifacts (styler 2)', () => {
  it('method gate rolls one row per enforcement step, with fail + pass states and the caption foot', () => {
    const gate = body.querySelector('#method .gate')!;
    expect(gate.querySelectorAll('.gate-steps[data-roll] .gate-step')).toHaveLength(METHOD.gate.steps.length);
    expect(gate.querySelector('.gate-step.is-fail')).not.toBeNull();
    expect(gate.querySelector('.gate-step.is-pass')).not.toBeNull();
    expect(gate.querySelector('.terminal-foot.tf-static')?.textContent).toContain(METHOD.gate.caption);
  });

  it('security boundary is one terminal: boundary rows, a command echo, then egress rows', () => {
    const boundary = body.querySelector('#security .boundary')!;
    const lists = boundary.querySelectorAll('.gate-steps[data-roll]');
    expect(lists).toHaveLength(2);
    expect(lists[0].querySelectorAll('.gate-step')).toHaveLength(SECURITY.boundary.rows.length);
    expect(lists[1].querySelectorAll('.gate-step')).toHaveLength(EGRESS.rows.length);
    expect(boundary.querySelector('.gate-echo')).not.toBeNull();
    expect(boundary.querySelector('.gate-step.is-deny')).not.toBeNull();
    expect(boundary.querySelector('.gate-step.is-redact')).not.toBeNull();
  });

  it('review board rolls a lane per reviewer; finding lanes show the finding -> fixed track; verdict pinned', () => {
    const board = body.querySelector('#pipeline .review-board')!;
    expect(board.querySelectorAll('.board-lanes[data-roll] .board-lane')).toHaveLength(PIPELINE.lanes.length);
    const findings = PIPELINE.lanes.filter((l) => l.result === 'finding').length;
    expect(board.querySelectorAll('.board-lane.is-finding')).toHaveLength(findings);
    expect(board.querySelector('.lane-step.is-finding')).not.toBeNull();
    expect(board.querySelector('.board-verdict')).not.toBeNull();
  });

  it('cost ledger rolls a row per sampled call and pins the totals, with the accent unattributed line', () => {
    const ledger = body.querySelector('#cost .ledger')!;
    expect(ledger.querySelectorAll('.ledger-rows[data-roll] .ledger-row')).toHaveLength(COST.ledger.rows.length);
    expect(ledger.querySelectorAll('.ledger-totals .ledger-total')).toHaveLength(COST.ledger.totals.length);
    expect(ledger.querySelector('.ledger-total.is-accent')).not.toBeNull();
  });

  it('the orchestration tree is live (data-orch) with one ticking row per agent', () => {
    const orch = body.querySelector('#orchestration .orch[data-orch]')!;
    expect(orch).not.toBeNull();
    expect(orch.querySelectorAll('[data-orch-agent]')).toHaveLength(ORCHESTRATION.agents.length);
  });
});

describe('dogfood terminal (roll-middle styler)', () => {
  it('pins the first + last line and rolls the middle of the status output', () => {
    const dogBody = body.querySelector('.dogfood-terminal .terminal-body')!;
    const roll = dogBody.querySelector('[data-roll]')!;
    expect(roll).not.toBeNull();
    expect(roll.querySelectorAll('.t-line')).toHaveLength(DOGFOOD.lines.length - 2);
  });
});

describe('grids, chips, nav, social proof, faq', () => {
  it('renders one 2-column grid (operations) and two 3-column grids (cost, runs-everywhere)', () => {
    expect(body.querySelectorAll('.feature-grid--2')).toHaveLength(1);
    expect(body.querySelectorAll('.feature-grid--3')).toHaveLength(2);
  });

  it('renders one agent chip per supported agent', () => {
    expect(body.querySelectorAll('.agent-chips span')).toHaveLength(AGENTS.length);
  });

  it('renders the pillar nav and the Sign in entry point', () => {
    expect(body.querySelectorAll('.site-nav .nav-links li a')).toHaveLength(NAV_LINKS.length);
    expect(body.querySelector('.nav-signin')?.getAttribute('href')).toBe(APP_LINKS.signIn);
  });

  it('renders one trusted logo link per logo and one FAQ item per question', () => {
    expect(body.querySelectorAll('.trusted-logos .trusted-logo-link')).toHaveLength(TRUSTED.logos.length);
    expect(body.querySelectorAll('.faq .faq-item')).toHaveLength(FAQ_ITEMS.length);
  });
});

describe('content invariants', () => {
  it('has no em-dash or en-dash anywhere in the rendered copy (CI tripwire)', () => {
    expect(text).not.toMatch(/[–—]/);
  });

  it('the privacy page still renders and carries no em/en dash', async () => {
    const container = await AstroContainer.create();
    const privacy = await container.renderToString(PrivacyPage);
    expect(privacy.length).toBeGreaterThan(0);
    expect(decodeEntities(privacy)).not.toMatch(/[–—]/);
  });
});

describe('REQ-LANDING-004: dark first paint (anti-flash contract)', () => {
  // BaseLayout declares the dark color scheme + paints the root dark inline so a
  // full-page navigation (landing <-> /login) never flashes the browser's white
  // default. Asserted as contract values on the head, not copy.
  let doc: Document;
  beforeAll(() => {
    doc = documentDom(html);
  });

  it('AC1: declares color-scheme dark in the head', () => {
    const meta = doc.querySelector('meta[name="color-scheme"]');
    expect(meta).not.toBeNull();
    expect(meta!.getAttribute('content')).toBe('dark');
  });

  it('AC1: paints the document root dark inline, before any external stylesheet', () => {
    const rootPaint = [...doc.querySelectorAll('style')]
      .map((s) => (s.textContent ?? '').replace(/\s+/g, ''))
      .find((css) => /^html\{[^}]*background-color:#[0-9a-f]{3,8}/i.test(css));
    expect(rootPaint, 'an inline html{} rule sets the dark root background').toBeTruthy();
    expect(rootPaint).toContain('color-scheme:dark');
  });

  it('AC1: also paints body dark inline so the page body never flashes white', () => {
    const bodyPaint = [...doc.querySelectorAll('style')]
      .map((s) => (s.textContent ?? '').replace(/\s+/g, ''))
      .find((css) => /body\{[^}]*background-color:#[0-9a-f]{3,8}/i.test(css));
    expect(bodyPaint, 'an inline body{} rule sets the dark body background').toBeTruthy();
  });
});
