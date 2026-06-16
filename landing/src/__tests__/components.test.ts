/**
 * Behavioral component tests for the extracted landing primitives + terminal
 * system. Each component is rendered via the Astro Container API and parsed into
 * a real DOM; the assertions check STRUCTURE and BEHAVIOUR (the caret styler,
 * slot routing, row/column counts, variant classes, attribute passthrough), not
 * copy strings. These are the contracts the page composition relies on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import HeroKicker from '../components/HeroKicker.astro';
import Terminal from '../components/Terminal.astro';
import Transcript from '../components/Transcript.astro';
import GateSteps from '../components/GateSteps.astro';
import Section from '../components/Section.astro';
import SectionHead from '../components/SectionHead.astro';
import FeatureGrid from '../components/FeatureGrid.astro';
import MicroCta from '../components/MicroCta.astro';
import Header from '../components/Header.astro';
import { dom } from './_helpers/dom';
import { HERO, NAV_LINKS, LOGIN, type TranscriptLine } from '../content/site';
import { APP_LINKS } from '../config';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

const LINES: TranscriptLine[] = [
  { tone: 'cmd', text: 'first' },
  { tone: 'agent', text: 'second' },
  { tone: 'ok', text: 'third' },
  { tone: 'dim', text: 'fourth' },
];

describe('HeroKicker', () => {
  it('renders one active capability word plus the queued vertical stack from the content model', async () => {
    const kicker = dom(await container.renderToString(HeroKicker)).querySelector('[data-hero-kicker]')!;
    expect(kicker).not.toBeNull();
    const words = kicker.querySelectorAll('[data-hero-kicker-word]');
    expect(words).toHaveLength(HERO.kicker.words.length);
    expect(words[0].getAttribute('data-active')).toBe('true');
    const queuedOpacity = parseFloat((words[1] as HTMLElement).style.opacity);
    expect(queuedOpacity).toBeGreaterThan(0);
    expect(queuedOpacity).toBeLessThan(1);
    expect(kicker.querySelector('.hero-kicker-reel')?.getAttribute('aria-hidden')).toBe('true');
    const measure = kicker.querySelector('[data-hero-kicker-measure]');
    expect(measure).not.toBeNull();
    expect(measure?.parentElement?.classList.contains('hero-kicker-reel')).toBe(true);
  });
});

describe('Transcript (styler 1: last line + scrolling cursor)', () => {
  it("animate='cursor' puts one caret on the last line and wraps that line for type-on-view", async () => {
    const body = dom(await container.renderToString(Transcript, { props: { lines: LINES, animate: 'cursor' } })).querySelector('.terminal-body')!;
    const tlines = body.querySelectorAll('.t-line');
    expect(tlines).toHaveLength(LINES.length);
    expect(body.querySelectorAll('.t-caret')).toHaveLength(1);
    expect(tlines[tlines.length - 1].querySelector('.t-caret')).not.toBeNull();
    expect(tlines[0].querySelector('.t-caret')).toBeNull();
    // Only the last line is marked [data-typeline] (type-on-view.ts's hook); it
    // carries the full line text so no-JS / reduced motion shows the resolved line.
    expect(body.querySelectorAll('[data-typeline]')).toHaveLength(1);
    expect(tlines[tlines.length - 1].querySelector('[data-typeline]')?.textContent).toBe(LINES[LINES.length - 1].text);
    expect(tlines[0].querySelector('[data-typeline]')).toBeNull();
    // The caret hugs the typed text: the caret directly follows the [data-typeline]
    // span with no whitespace text node between them. `.t-line` is white-space: pre,
    // so a gap would render as a visible space — the hero has none, these must match.
    const lastLine = tlines[tlines.length - 1];
    expect(lastLine.querySelector('.t-caret')!.previousSibling).toBe(lastLine.querySelector('[data-typeline]'));
    expect(body.querySelector('.ft-typed')).toBeNull();
    expect(body.querySelector('[data-roll]')).toBeNull();
  });

  it("animate='typed' appends a typed command line (ft-typed + caret) after the transcript", async () => {
    const body = dom(await container.renderToString(Transcript, { props: { lines: LINES, animate: 'typed', typed: 'tail cmd' } })).querySelector('.terminal-body')!;
    const tlines = body.querySelectorAll('.t-line');
    expect(tlines).toHaveLength(LINES.length + 1);
    const typedLine = tlines[tlines.length - 1];
    expect(typedLine.classList.contains('t-cmd')).toBe(true);
    expect(typedLine.querySelector('.ft-typed[data-ft-typed]')?.textContent).toBe('tail cmd');
    expect(typedLine.querySelector('.t-caret')).not.toBeNull();
    // The transcript lines themselves carry no caret in typed mode.
    expect(tlines[0].querySelector('.t-caret')).toBeNull();
    // Type-on-view is cursor-mode only; the typed reel uses its own .ft-typed line.
    expect(body.querySelector('[data-typeline]')).toBeNull();
  });

  it("animate='roll-middle' pins the first and last line and rolls only the middle", async () => {
    const body = dom(await container.renderToString(Transcript, { props: { lines: LINES, animate: 'roll-middle' } })).querySelector('.terminal-body')!;
    const roll = body.querySelector('[data-roll]')!;
    expect(roll).not.toBeNull();
    expect(roll.querySelectorAll('.t-line')).toHaveLength(LINES.length - 2);
    const pinned = Array.from(body.children).filter((c) => c.classList.contains('t-line'));
    expect(pinned).toHaveLength(2);
    expect(pinned[0].textContent).toContain(LINES[0].text);
    expect(pinned[1].textContent).toContain(LINES[LINES.length - 1].text);
    expect(body.querySelector('.t-caret')).toBeNull();
    expect(body.querySelector('[data-typeline]')).toBeNull();
  });

  it("default animate='static' renders plain lines with no caret, roll, or typed line", async () => {
    const body = dom(await container.renderToString(Transcript, { props: { lines: LINES } })).querySelector('.terminal-body')!;
    expect(body.querySelectorAll('.t-line')).toHaveLength(LINES.length);
    expect(body.querySelector('.t-caret')).toBeNull();
    expect(body.querySelector('[data-roll]')).toBeNull();
    expect(body.querySelector('.ft-typed')).toBeNull();
    expect(body.querySelector('[data-typeline]')).toBeNull();
  });
});

describe('Terminal (shared chrome)', () => {
  it('renders the dots, a plain title, the body slot, a tf-static foot, and data-proof + reveal by default', async () => {
    const t = dom(
      await container.renderToString(Terminal, {
        props: { variant: 'proof-terminal', title: 'codeflare · web', foot: 'a caption' },
        slots: { default: '<div class="terminal-body"><span class="t-line">x</span></div>' },
      })
    ).querySelector('.terminal')!;
    expect(t.classList.contains('proof-terminal')).toBe(true);
    expect(t.classList.contains('reveal')).toBe(true);
    expect(t.hasAttribute('data-proof')).toBe(true);
    expect(t.querySelectorAll('.terminal-dots span')).toHaveLength(3);
    expect(t.querySelector('.terminal-bar .terminal-title')?.textContent).toBe('codeflare · web');
    expect(t.querySelector('.terminal-body')).not.toBeNull();
    expect(t.querySelector('.terminal-foot.tf-static')?.textContent).toContain('a caption');
  });

  it('reveal={false} omits the .reveal class (hero/feature terminals carry it on their wrapper)', async () => {
    const t = dom(await container.renderToString(Terminal, { props: { reveal: false, title: 'x' } })).querySelector('.terminal')!;
    expect(t.classList.contains('reveal')).toBe(false);
  });

  it('with no title, the bar slot is rendered instead of a .terminal-title', async () => {
    const t = dom(
      await container.renderToString(Terminal, {
        props: { variant: 'gate' },
        slots: { bar: '<span class="gate-req">REQ-1</span>', default: '<div class="gate-steps"></div>' },
      })
    ).querySelector('.terminal')!;
    expect(t.querySelector('.terminal-title')).toBeNull();
    expect(t.querySelector('.terminal-bar .gate-req')?.textContent).toBe('REQ-1');
  });

  it('with a foot slot and no foot prop, the custom foot is used (no tf-static)', async () => {
    const t = dom(
      await container.renderToString(Terminal, {
        props: { title: 'x' },
        slots: { default: '<div class="terminal-body"></div>', foot: '<div class="terminal-foot" data-agentfoot>statusline</div>' },
      })
    ).querySelector('.terminal')!;
    expect(t.querySelector('.terminal-foot.tf-static')).toBeNull();
    expect(t.querySelector('.terminal-foot[data-agentfoot]')).not.toBeNull();
  });

  it('renders the reel hooks (ftLoop, ftShuffle) and the orch hook as the expected data-* attributes', async () => {
    const reel = dom(
      await container.renderToString(Terminal, {
        props: { title: 'x', ftLoop: '["a","b"]', ftShuffle: true },
        slots: { default: '<div></div>' },
      })
    ).querySelector('.terminal')!;
    expect(JSON.parse(reel.getAttribute('data-ft-loop')!)).toEqual(['a', 'b']);
    expect(reel.hasAttribute('data-ft-shuffle')).toBe(true);
    expect(reel.hasAttribute('data-orch')).toBe(false);

    const tree = dom(
      await container.renderToString(Terminal, { props: { variant: 'orch', orch: true }, slots: { default: '<div></div>' } })
    ).querySelector('.terminal')!;
    expect(tree.hasAttribute('data-orch')).toBe(true);
    expect(tree.hasAttribute('data-ft-loop')).toBe(false);
  });
});

describe('GateSteps (styler 2: rolling rows)', () => {
  const ROWS = [
    { actor: 'spec-enforce', label: 'failed', text: 'AC3 not covered', state: 'is-fail' },
    { actor: 'agent', label: 'correcting', text: 'writes the case', state: 'is-work' },
    { actor: 'merge', label: 'passed', text: 'allowed', state: 'is-pass' },
    { actor: 'scaffolding', label: 'attached', text: 'standards' },
  ];

  it('renders one rolling row per item, with actor / state / text and the state colour class', async () => {
    const list = dom(await container.renderToString(GateSteps, { props: { rows: ROWS } })).querySelector('.gate-steps[data-roll]')!;
    expect(list).not.toBeNull();
    const steps = list.querySelectorAll('.gate-step');
    expect(steps).toHaveLength(ROWS.length);
    expect(steps[0].classList.contains('is-fail')).toBe(true);
    expect(steps[0].querySelector('.gate-actor')?.textContent).toBe('spec-enforce');
    expect(steps[0].querySelector('.gate-state')?.textContent).toBe('failed');
    expect(steps[0].querySelector('.gate-text')?.textContent).toBe('AC3 not covered');
  });

  it('a row without a state gets only the base .gate-step class (neutral row)', async () => {
    const list = dom(await container.renderToString(GateSteps, { props: { rows: ROWS } })).querySelector('.gate-steps')!;
    const neutral = list.querySelectorAll('.gate-step')[3];
    expect(neutral.className.trim()).toBe('gate-step');
  });
});

describe('Section + SectionHead', () => {
  it('Section wraps a .container; alt adds the tint band', async () => {
    const plain = dom(await container.renderToString(Section, { props: { id: 'x' }, slots: { default: '<p>body</p>' } })).querySelector('section')!;
    expect(plain.id).toBe('x');
    expect(plain.classList.contains('section--alt')).toBe(false);
    expect(plain.querySelector('.container p')?.textContent).toBe('body');
    const alt = dom(await container.renderToString(Section, { props: { id: 'y', alt: true } })).querySelector('section')!;
    expect(alt.classList.contains('section--alt')).toBe(true);
  });

  it('SectionHead renders a top-level h2 with kicker + lead', async () => {
    const head = dom(await container.renderToString(SectionHead, { props: { kicker: 'Velocity', title: 'The title', lead: 'The lead' } })).querySelector('.section-head')!;
    expect(head.classList.contains('substation')).toBe(false);
    expect(head.querySelector('h2')?.textContent).toBe('The title');
    expect(head.querySelector('h3')).toBeNull();
    expect(head.querySelector('.kicker')?.textContent).toBe('Velocity');
    expect(head.querySelector('.lead')?.textContent).toBe('The lead');
  });

  it('SectionHead substation renders an h3 under .substation', async () => {
    const head = dom(await container.renderToString(SectionHead, { props: { kicker: 'security/operations', title: 'Ops', lead: 'x', substation: true } })).querySelector('.section-head')!;
    expect(head.classList.contains('substation')).toBe(true);
    expect(head.querySelector('h3')?.textContent).toBe('Ops');
    expect(head.querySelector('h2')).toBeNull();
  });

  it('SectionHead leadHtml renders inline markup; no lead renders no .lead; the slot trails the lead', async () => {
    const withHtml = dom(await container.renderToString(SectionHead, { props: { kicker: 'k', title: 't', leadHtml: 'Deployed in <strong>your own estate</strong>.' } })).querySelector('.section-head')!;
    expect(withHtml.querySelector('.lead strong')?.textContent).toBe('your own estate');

    const noLead = dom(await container.renderToString(SectionHead, { props: { kicker: 'k', title: 't' } })).querySelector('.section-head')!;
    expect(noLead.querySelector('.lead')).toBeNull();

    const withSlot = dom(
      await container.renderToString(SectionHead, {
        props: { kicker: 'k', title: 't', lead: 'l' },
        slots: { default: '<p class="micro-cta"><a href="#contact">go</a></p>' },
      })
    ).querySelector('.section-head')!;
    expect(withSlot.querySelector('.micro-cta a')?.getAttribute('href')).toBe('#contact');
  });
});

describe('FeatureGrid', () => {
  const CARDS = [
    { title: 'A', body: 'a body' },
    { title: 'B', body: 'b body' },
    { title: 'C', body: 'c body' },
  ];

  it('renders one .feature-col per card with the column-count modifier and the stagger hook', async () => {
    const grid = dom(await container.renderToString(FeatureGrid, { props: { cards: CARDS, cols: 3 } })).querySelector('.feature-grid')!;
    expect(grid.classList.contains('feature-grid--3')).toBe(true);
    expect(grid.hasAttribute('data-stagger')).toBe(true);
    const cols = grid.querySelectorAll('.feature-col');
    expect(cols).toHaveLength(3);
    expect(cols[0].querySelector('h3')?.textContent).toBe('A');
    expect(cols[0].querySelector('p')?.textContent).toBe('a body');

    const two = dom(await container.renderToString(FeatureGrid, { props: { cards: CARDS.slice(0, 2), cols: 2 } })).querySelector('.feature-grid')!;
    expect(two.classList.contains('feature-grid--2')).toBe(true);
    expect(two.querySelectorAll('.feature-col')).toHaveLength(2);
  });
});

describe('MicroCta', () => {
  it('renders an in-page link with an optional topic, no new-tab attrs by default', async () => {
    const p = dom(await container.renderToString(MicroCta, { props: { href: '#contact', label: 'Request the brief', dataTopic: 'security-compliance' } })).querySelector('.micro-cta')!;
    expect(p.classList.contains('reveal')).toBe(false);
    const a = p.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('#contact');
    expect(a.getAttribute('data-topic')).toBe('security-compliance');
    expect(a.textContent).toBe('Request the brief');
    expect(a.hasAttribute('target')).toBe(false);
  });

  it('external opens in a new tab; class + reveal modifiers apply', async () => {
    const p = dom(await container.renderToString(MicroCta, { props: { href: 'https://x', label: 'See it', external: true, class: 'dogfood-cta', reveal: true } })).querySelector('.micro-cta')!;
    expect(p.classList.contains('dogfood-cta')).toBe(true);
    expect(p.classList.contains('reveal')).toBe(true);
    const a = p.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener');
  });
});

describe('Header (one nav, two variants)', () => {
  it("variant='landing' renders the brand, a link per nav pillar, and the Sign in button", async () => {
    const nav = dom(await container.renderToString(Header, { props: { variant: 'landing' } })).querySelector('.site-nav')!;
    expect(nav.classList.contains('login-nav')).toBe(false);
    expect(nav.querySelector('.brand')).not.toBeNull();
    expect(nav.querySelectorAll('.nav-links li a')).toHaveLength(NAV_LINKS.length);
    expect(nav.querySelector('.nav-signin')?.getAttribute('href')).toBe(APP_LINKS.signIn);
    expect(nav.querySelector('.login-back')).toBeNull();
  });

  it("variant='login' renders only the back link (no pillar nav)", async () => {
    const nav = dom(await container.renderToString(Header, { props: { variant: 'login' } })).querySelector('.site-nav')!;
    expect(nav.classList.contains('login-nav')).toBe(true);
    expect(nav.querySelector('.login-back')?.getAttribute('href')).toBe(LOGIN.back.href);
    expect(nav.querySelector('.login-back-arrow')).not.toBeNull();
    expect(nav.querySelector('.nav-links')).toBeNull();
  });
});
