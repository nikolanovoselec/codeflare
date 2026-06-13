import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import IndexPage from '../pages/index.astro';
import PrivacyPage from '../pages/privacy.astro';
import { APP_LINKS } from '../config';
import {
  AGENTS,
  BROWSER,
  CONTACT_FORM,
  COST,
  DOGFOOD,
  GITHUB_URL,
  EGRESS,
  FAQ_ITEMS,
  FEATURE_TERMINALS,
  HERO,
  CONTEXT,
  LEGACY,
  METHOD,
  NAV_LINKS,
  OPERATIONS,
  PLATFORM,
  PIPELINE,
  SECURITY,
  SHIFT,
  SPINE,
  TENANCY,
  TERMINAL,
  TRUSTED,
  ORCHESTRATION,
} from '../content/site';

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
  html = await container.renderToString(IndexPage);
  text = decodeEntities(html);
});

describe('landing page (REQ-LANDING-001)', () => {
  it('REQ-LANDING-001: hero renders the kicker, both CTA hrefs, and the scramble + fluid hooks on the flare word', () => {
    // Kicker text must appear in the rendered output, not just be present in site.ts.
    expect(text).toContain(HERO.kicker);
    // Both CTAs route to their configured destinations — wrong href = broken conversion path.
    expect(html).toContain(`href="${HERO.primaryCta.href}"`);
    expect(html).toContain(`href="${HERO.secondaryCta.href}"`);
    // The flare word carries data-scramble so the client script can find it.
    // Asserting the attribute is absent would leave this green if the word renders
    // as plain text (script can't hook it); asserting only the class is theater.
    expect(html).toContain('data-scramble');
    // The fluid canvas mount-point must be in the DOM for the client layer.
    expect(html).toContain('data-flare-fluid');
  });

  it('REQ-LANDING-001: hero terminal carries the ft-loop attribute with the full command array and a ft-typed slot', () => {
    // data-ft-loop must carry the JSON-serialised loop array so the script can parse it.
    // Asserting .toContain('data-ft-loop') alone is theater — it passes even if the
    // value is an empty string.  Parse the attribute value from HTML directly.
    const loopMatch = html.match(/data-ft-loop="([^"]*)"/);
    expect(loopMatch).not.toBeNull();
    const loopValue = loopMatch![1].replace(/&quot;/g, '"');
    const parsed: string[] = JSON.parse(loopValue);
    // The full run sequence must be serialised — deleting one from site.ts fails here.
    expect(parsed).toEqual(TERMINAL.run);
    // The hero plays once (types through the reel and stops, no infinite loop):
    // data-ft-once marks no loop-back. data-ft-shuffle randomises the beat order
    // on each load so the capability reel reads differently every visit.
    expect(html).toContain('data-ft-once');
    expect(html).toContain('data-ft-shuffle');
    // The typed slot renders with the first command as its initial text content.
    expect(html).toContain('data-ft-typed');
    // The server-rendered resting state is run[0] so the page is legible without JS
    // (the shuffle is client-side only; SSR always emits the authored run[0]).
    expect(text).toContain(TERMINAL.run[0]);
  });

  it('REQ-LANDING-001: hero transcript contains the governed-run narrative (drift warn, egress deny, alignment ok)', () => {
    // The enforcement narrative is the page's core claim. A regression in the
    // template that removes any of these states would leave the buyer without
    // the proof the copy promises.
    expect(html).toContain('t-warn');
    expect(html).toContain('t-deny');
    expect(text).toContain('drift · blocking finding');
    expect(text).toContain('direct provider call denied');
    expect(text).toContain('spec · code · docs aligned');
    // The spine PR must close the transcript — it is the claim that the run shipped.
    expect(text).toContain(SPINE.pr);
  });

  it('REQ-LANDING-001: hero terminal foot renders the agentfoot hooks with the static ctx/model/reason values', () => {
    // The foot must carry data-agentfoot so agentfoot.ts can find it.
    expect(html).toContain('data-agentfoot');
    // data-tf-ctx and data-tf-reason are the animated segments; their static
    // content must match TERMINAL.foot so the no-JS state is correct.
    expect(html).toContain('data-tf-ctx');
    expect(html).toContain('data-tf-reason');
    expect(text).toContain(TERMINAL.foot.ctx);
    expect(text).toContain(TERMINAL.foot.model);
    expect(text).toContain(TERMINAL.foot.reason);
  });

  it('REQ-LANDING-001: hero spine strip links SPINE.req and SPINE.pr into the page', () => {
    // The spine strip is the page's quiet table of contents.  Both identifiers
    // must be present — stripping either leaves the strip empty or broken.
    expect(html).toContain('hero-spine');
    expect(text).toContain(SPINE.req);
    expect(text).toContain(SPINE.pr);
  });

  it('REQ-LANDING-001: nav exposes a sign-in launch path and every nav link has a matching section id', () => {
    expect(html).toContain(`href="${APP_LINKS.signIn}"`);
    expect(html).toContain('Sign in');
    // Every NAV_LINKS entry must have both a rendered label and a target section
    // in the DOM — a broken href or missing section would leave nav orphaned.
    for (const link of NAV_LINKS) {
      expect(html).toContain(link.label);
      expect(html).toContain(`id="${link.href.replace('#', '')}"`);
    }
    expect(html).toContain('id="contact"');
  });

  it('REQ-LANDING-001: hero terminal renders every transcript line statically (legible with no JS)', () => {
    // All lines must be in the initial HTML so the terminal reads without JS.
    expect(html).toContain(TERMINAL.title);
    for (const line of TERMINAL.lines) {
      expect(html).toContain(line.text);
    }
  });

  it('REQ-LANDING-001: shift renders as a feature-terminal grid with every tile title, line, and caption foot', () => {
    expect(html).toContain('id="shift"');
    expect(text).toContain(SHIFT.title);
    expect(html).toContain('feature-terminals');
    for (const ft of FEATURE_TERMINALS) {
      expect(text).toContain(ft.title);
      // The foot is the caption that summarises what each terminal proves.
      expect(text).toContain(ft.foot);
      for (const line of ft.lines) {
        // Entity-decoded comparison because Astro escapes apostrophes.
        expect(text).toContain(line.text);
      }
    }
  });

  it('REQ-LANDING-001: method section renders the pillars and the self-healing enforcement gate', () => {
    expect(html).toContain('id="method"');
    // Both pillars must render — stripping one removes half the method narrative.
    for (const pillar of METHOD.pillars) {
      expect(text).toContain(pillar.title);
    }
    // The gate is the proof artifact: must have a data-proof hook so the
    // proof.ts script arms it, and must render every step.
    expect(html).toContain('data-proof');
    expect(text).toContain(METHOD.gate.req);
    expect(text).toContain(METHOD.gate.criterion);
    for (const step of METHOD.gate.steps) {
      expect(text).toContain(step.actor);
      expect(text).toContain(step.text);
    }
    // The gate must show at least one failure and one pass — an all-green gate
    // is theater; an all-red gate is broken.
    expect(html).toContain('is-fail');
    expect(html).toContain('is-pass');
    // The caption is the enforcement refrain. Assert the characteristic phrase
    // that cannot accidentally appear from any other element on the page.
    expect(text).toContain('Drift is a blocking finding');
    // The method body must NOT carry a coral numbered counter.  The clauses read
    // as plain label-and-prose pillars with no decorative ordinal. Asserting
    // method-clauses still renders (the <ol> exists) but that no list-item counter
    // style leaks into the page via an inline counter-reset attribute verifies the
    // implementation without reading CSS.
    expect(html).toContain('method-clauses');
    // No inline counter-reset style on the <ol> — the method clauses read as plain
    // label-and-prose pillars, with no decorative numbered counter of their own.
    expect(html).not.toMatch(/method-clauses[^>]*style="[^"]*counter/);
  });

  it('REQ-LANDING-001: security section renders exactly ONE merged terminal containing both boundary rows and egress rows', () => {
    expect(html).toContain('id="security"');
    // The boundary gate class must be present — it is the merged container.
    expect(html).toContain('gate boundary');
    // Boundary rows: at least one pass and one deny, with rendered actor/label/text.
    for (const row of SECURITY.boundary.rows) {
      expect(text).toContain(row.actor);
      expect(text).toContain(row.label);
      expect(text).toContain(row.text);
    }
    expect(html).toContain('is-deny');
    expect(html).toContain('is-pass');
    // The one outbound call is introduced by a left-aligned command echo (gate-echo),
    // not a centered footer-in-the-middle; its absence means the merge did not happen
    // and security reads as boundary-only.
    expect(html).toContain('gate-echo');
    // Egress rows render inside the same terminal — the call identifier must appear.
    expect(text).toContain(EGRESS.call);
    for (const row of EGRESS.rows) {
      expect(text).toContain(row.actor);
      expect(text).toContain(row.text);
    }
    // The egress rows animate (roll) like the boundary rows above, not sit static:
    // the egress list must carry the data-roll hook proof.ts arms.
    expect(html).toMatch(/gate-echo[\s\S]*?data-roll/);
    // The DLP redaction is the one amber beat — must be a first-class state.
    expect(html).toContain('is-redact');
    // ONE merged foot covers both: the security caption closes the whole receipt.
    // Assert the characteristic phrase rather than a .slice tautology.
    expect(text).toContain('The boundary is yours');
    // There must be NO separate "gate egress" element (the pre-merge layout had one).
    expect(html).not.toContain('gate egress');
    // The AI Gateway must be named as the egress control in the merged terminal.
    expect(text).toContain('your AI Gateway');
  });

  it('REQ-LANDING-001: legacy section renders between method and security with the /sdd init + /sdd clean transcript', () => {
    expect(html).toContain('id="legacy"');
    expect(text).toContain(LEGACY.title);
    // The terminal must carry both rescue commands — deleting either removes half
    // the rescue narrative the spec mandates.
    expect(text).toContain('/sdd init --import legacy-payments');
    expect(text).toContain('/sdd clean');
    // Every transcript line must render.
    for (const line of LEGACY.terminal.lines) {
      expect(text).toContain(line.text);
    }
    // The terminal closes on a normalised in-chrome foot.
    expect(text).toContain(LEGACY.terminal.foot);
    // The legacy section must appear BEFORE security in the document order, and the
    // legacy terminal is now paired with prose (proof-pair), not an odd-width box.
    const legacyPos = html.indexOf('id="legacy"');
    const securityPos = html.indexOf('id="security"');
    expect(legacyPos).toBeGreaterThan(0);
    expect(legacyPos).toBeLessThan(securityPos);
    const legacySection = html.slice(legacyPos, securityPos);
    expect(legacySection).toContain('proof-pair');
    expect(legacySection).toContain('proof-terminal');
  });

  it('REQ-LANDING-001: the numbered station spine is gone; sections render as calm peers in document order', () => {
    // The owner dropped the 01-11 numbered station spine (an AI-tell). Guard against
    // the markers creeping back, and assert the sections still render in the intended
    // order, cued now by alternating backgrounds rather than ordinals.
    expect(html).not.toContain('station-marker');
    expect(html).not.toMatch(/data-station=/);
    const order = [
      'shift', 'method', 'legacy', 'security', 'context', 'pipeline',
      'orchestration', 'cost', 'platform', 'dogfood', 'faq', 'contact',
    ];
    const positions = order.map((id) => html.indexOf(`id="${id}"`));
    for (const p of positions) expect(p).toBeGreaterThan(0);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('REQ-LANDING-001: every instrument terminal closes on a normalised in-chrome terminal-foot element', () => {
    // The spec mandates every terminal ends with .terminal-foot.  Count the
    // occurrences in the rendered HTML: hero + feature-terminals (4) + method gate
    // + legacy + security (merged, one foot) + context + dogfood = at minimum 9.
    // A regression that strips a foot from any terminal drops this count.
    const footCount = [...html.matchAll(/class="terminal-foot/g)].length;
    expect(footCount).toBeGreaterThanOrEqual(9);
  });

  it('REQ-LANDING-001: dogfood section shows REQ-LANDING-001 with real @impl/@test anchors and PR #533', () => {
    expect(html).toContain('id="dogfood"');
    expect(text).toContain(DOGFOOD.title);
    expect(text).toContain(DOGFOOD.terminalTitle);
    // The @impl and @test anchors are the load-bearing proof that the spec is real.
    expect(text).toContain('@impl landing/src/pages/index.astro');
    expect(text).toContain('@test landing/src/__tests__/index-page.test.ts');
    // Status and PR must be verbatim — these are the auditable claims.
    expect(text).toContain('Status: Implemented');
    expect(text).toContain('PR #533');
    // The terminal closes on a normalised foot.
    expect(text).toContain(DOGFOOD.foot);
    // The dogfood CTA href must point at the public repo.
    expect(html).toContain(`href="${GITHUB_URL}"`);
    expect(text).toContain(DOGFOOD.cta.label);
  });

  it('REQ-LANDING-001: the Trusted-by strip renders the Swiss Post logo + label in the proof section, before the contact CTA', () => {
    // The label + the actual logo asset must render — a missing src is a broken
    // proof, and alt text is required for the logo to be accessible.
    expect(text).toContain(TRUSTED.label);
    expect(html).toContain(`src="${TRUSTED.logo.src}"`);
    expect(html).toContain(`alt="${TRUSTED.logo.alt}"`);
    // The logo links to the customer's site, opened safely in a new tab.
    expect(html).toContain(`href="${TRUSTED.logo.href}"`);
    expect(html).toMatch(/<a[^>]*href="https:\/\/www\.post\.ch"[^>]*rel="noopener noreferrer"/);
    // Placement (owner's choice): after the dogfood proof, immediately before the
    // contact section. Use the logo asset's position so it is class-name agnostic.
    const trustedPos = html.indexOf(TRUSTED.logo.src);
    const dogfoodPos = html.indexOf('id="dogfood"');
    const contactPos = html.indexOf('id="contact"');
    expect(trustedPos).toBeGreaterThan(dogfoodPos);
    expect(trustedPos).toBeLessThan(contactPos);
  });

  it('REQ-LANDING-001: orchestration is its own dynamic section with normal agent commands, between review and spend', () => {
    // The operator "Running N agents" view is now its own section, relocated out
    // from under the review board (the two stacked terminals read as redundant).
    expect(html).toContain('id="orchestration"');
    expect(text).toContain(ORCHESTRATION.title);
    expect(html).toContain('terminal orch');
    expect(text).toContain(ORCHESTRATION.header);
    expect(text).toContain(ORCHESTRATION.hint); // ctrl+o to expand
    expect(text).toContain(ORCHESTRATION.footHint); // ctrl+b to run in background
    for (const agent of ORCHESTRATION.agents) {
      expect(text).toContain(agent.agent);
      // Resolved counters render as numbers (orch.ts ticks them live).
      expect(text).toContain(String(agent.toolUses));
      expect(text).toContain(agent.tokens.toFixed(1));
      // activities[0] is the resolved, no-JS activity line.
      expect(text).toContain(agent.activities[0]);
    }
    // The activity lines are ordinary agent commands now, not ctx-mode internals.
    expect(text).not.toContain('ctx_batch_execute');
    // The live-feed hooks orch.ts drives must be present (counters + activity).
    expect(html).toContain('data-orch');
    expect(html).toContain('data-orch-agent');
    expect(html).toContain('data-orch-tooluses');
    expect(html).toContain('data-orch-tokens');
    expect(html).toContain('data-orch-activity');
    expect(html).toContain('data-activities');
    // It is armed as a proof artifact too (proof.ts reveals it on scroll-in).
    expect(html).toMatch(/class="terminal orch[^"]*"\s+data-proof/);
    // Position: after the review section, before the spend section.
    const orchPos = html.indexOf('id="orchestration"');
    const pipelinePos = html.indexOf('id="pipeline"');
    const costPos = html.indexOf('id="cost"');
    expect(orchPos).toBeGreaterThan(pipelinePos);
    expect(orchPos).toBeLessThan(costPos);
  });

  it('REQ-LANDING-001: footer carries NO GitHub link and NO nav links — only the BUILT WITH line', () => {
    // The footer was reduced to one line in the redesign.  A regression that
    // re-adds the GitHub link or nav links to the footer would pass the dogfood
    // CTA test above (GitHub URL still present) but fail this count check.
    expect(html).not.toContain('footer-gh');
    expect(html).not.toContain('Codeflare on GitHub');
    // The repo link must appear exactly once (dogfood CTA only; not footer).
    const ghOccurrences = html.split(`href="${GITHUB_URL}"`).length - 1;
    expect(ghOccurrences).toBe(1);
  });

  it('REQ-LANDING-001: footer links the Gray Matter wordmark to graymatter.ch', () => {
    // The copyright wordmark is a real link to the company site, not plain text.
    // A regression that drops the link (or points it elsewhere) fails this.
    expect(html).toMatch(/<a[^>]*href="https:\/\/graymatter\.ch"[^>]*>Gray Matter GmbH<\/a>/);
  });

  it('REQ-LANDING-001: operations folds into the boundary section as sub-content, not its own section', () => {
    // Operations is now sub-content of the boundary section, so the standalone
    // section is gone and the content renders inside security as a .substation.
    expect(html).not.toContain('id="operations"');
    expect(html).toContain('substation');
    expect(text).toContain(OPERATIONS.title);
    // The load-bearing capability phrase must survive the merge.
    expect(text).toContain('zero-trust');
    for (const card of OPERATIONS.cards) {
      expect(text).toContain(card.title);
    }
    // It belongs to the security section: its content sits within it, between the
    // boundary terminal and the next section (context).
    const opsPos = html.indexOf(OPERATIONS.title);
    const securityPos = html.indexOf('id="security"');
    const contextPos = html.indexOf('id="context"');
    expect(opsPos).toBeGreaterThan(securityPos);
    expect(opsPos).toBeLessThan(contextPos);
  });

  it('REQ-LANDING-001: tenancy and runs-everywhere fold into their parent sections as sub-content (nothing floats)', () => {
    // Tenancy belongs to the spend (cost) section: standalone section gone, content
    // renders within cost, before the platform section.
    expect(html).not.toContain('id="tenancy"');
    expect(text).toContain(TENANCY.title);
    const tenancyPos = html.indexOf(TENANCY.title);
    const costPos = html.indexOf('id="cost"');
    const platformPos = html.indexOf('id="platform"');
    expect(tenancyPos).toBeGreaterThan(costPos);
    expect(tenancyPos).toBeLessThan(platformPos);
    // Runs-everywhere belongs to the platform section: standalone section gone,
    // content renders within platform, before the answers (FAQ) section.
    expect(html).not.toContain('id="browser"');
    expect(text).toContain(BROWSER.title);
    for (const card of BROWSER.cards) {
      expect(text).toContain(card.title);
    }
    const browserPos = html.indexOf(BROWSER.title);
    const faqPos = html.indexOf('id="faq"');
    expect(browserPos).toBeGreaterThan(platformPos);
    expect(browserPos).toBeLessThan(faqPos);
  });

  it('REQ-LANDING-001: platform section carries the session-boot seed terminal (a live artifact, not prose cards)', () => {
    // The "arrives equipped" proof is a rolling boot log in the terminal idiom,
    // inside the platform section, so this section reads like every other one
    // instead of a wall of feature cards.
    const platformPos = html.indexOf('id="platform"');
    const dogfoodPos = html.indexOf('id="dogfood"');
    const seedTitlePos = html.indexOf(PLATFORM.seed.title);
    expect(seedTitlePos).toBeGreaterThan(platformPos);
    expect(seedTitlePos).toBeLessThan(dogfoodPos);
    // Every capability row renders its actor + description (deleting one from
    // site.ts fails here — not theater).
    for (const row of PLATFORM.seed.rows) {
      expect(text).toContain(row.actor);
      expect(text).toContain(row.text);
    }
    expect(text).toContain(PLATFORM.seed.caption);
    // It is a scroll-revealed proof artifact (data-proof) whose rows roll in
    // (data-roll), reusing the gate idiom.
    const platformBlock = html.slice(platformPos, dogfoodPos);
    expect(platformBlock).toContain('data-proof');
    expect(platformBlock).toContain('data-roll');
    expect(platformBlock).toContain('gate-step');
    // The old prose-card grid is gone from this section.
    expect(platformBlock).not.toContain('feature-grid--2');
    // No em/en dashes anywhere in the rendered seed copy (CI tripwire parity).
    const seedCopy = [
      PLATFORM.seed.title,
      PLATFORM.seed.meta,
      PLATFORM.seed.caption,
      ...PLATFORM.seed.rows.flatMap((r) => [r.actor, r.label, r.text]),
    ].join(' ');
    expect(seedCopy).not.toMatch(/[—–]/);
  });

  it('REQ-LANDING-001: context section renders the isolation proof terminal as a proof-pair with in-chrome foot', () => {
    expect(html).toContain('id="context"');
    // The narrative terminal is now paired with prose (proof-pair / proof-terminal),
    // normalized to the page's paired-terminal rhythm instead of an odd 56rem box.
    const contextPos = html.indexOf('id="context"');
    const pipelinePos = html.indexOf('id="pipeline"');
    const contextSection = html.slice(contextPos, pipelinePos);
    expect(contextSection).toContain('proof-pair');
    expect(contextSection).toContain('proof-terminal');
    // The proof terminal must render with every line — it is the isolation claim.
    for (const line of CONTEXT.terminal.lines) {
      expect(text).toContain(line.text);
    }
    expect(text).toContain(CONTEXT.terminal.foot);
    // The section also carries the agent-steered e2e proof (the "drive" surface
    // beside the "read"/markdown one), paired and flipped: its heading and every
    // transcript line must render, including the pass/fail verdict lines.
    expect(text).toContain(CONTEXT.e2e.heading);
    expect(contextSection).toContain('proof-pair--flip');
    for (const line of CONTEXT.e2e.terminal.lines) {
      expect(text).toContain(line.text);
    }
    expect(text).toContain(CONTEXT.e2e.terminal.foot);
  });

  it('REQ-LANDING-001: parallel review board renders lanes, a caught finding, and the human triage verdict', () => {
    expect(html).toContain('review-board');
    expect(html).toContain('id="pipeline"');
    expect(html).toContain('board-dispatch');
    for (const lane of PIPELINE.lanes) {
      expect(html).toContain(lane.agent);
      expect(text).toContain(lane.note);
    }
    // The board must show a caught finding — an all-clean board is theater.
    expect(html).toContain('is-finding');
    expect(text).toContain(PIPELINE.verdict.title);
    expect(text).toContain(PIPELINE.verdict.note);
  });

  it('REQ-LANDING-001: cost section renders the attribution ledger with zero unattributed total', () => {
    expect(html).toContain('id="cost"');
    // The ledger is the literal bill — every agent row must appear.
    expect(html).toContain('ledger-totals');
    expect(html).toContain('ledger-meta');
    for (const row of COST.ledger.rows) {
      expect(text).toContain(row.agent);
    }
    // The zero-unattributed total is the load-bearing cost claim.
    const unattributed = COST.ledger.totals.find((t) => t.label === 'unattributed');
    expect(unattributed).toBeDefined();
    expect(unattributed?.accent).toBe(true);
    expect(text).toContain(unattributed!.value);
  });

  it('REQ-LANDING-001: contact form renders every required field and every backend-accepted topic value', () => {
    // Field names must match exactly what the contact-controller and API expect.
    expect(html).toContain('name="name"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="company"');
    expect(html).toContain('name="topic"');
    expect(html).toContain('name="message"');
    for (const topic of CONTACT_FORM.topics) {
      expect(html).toContain(`value="${topic.value}"`);
    }
  });

  it('REQ-LANDING-001: the agent roster renders all configured agent identifiers', () => {
    for (const agent of AGENTS) {
      expect(html).toContain(agent);
    }
  });

  it('REQ-LANDING-001: every FAQ question renders in the page', () => {
    for (const item of FAQ_ITEMS) {
      expect(text).toContain(item.question);
    }
  });

  it('REQ-LANDING-001: deprecated chrome is absent (no statusbar, fleet, animated-transcript, or flare-block)', () => {
    expect(html).not.toContain('id="statusbar"');
    expect(html).not.toContain('data-fleet=');
    expect(html).not.toContain('data-tt=');
    expect(html).not.toContain('flare-block');
  });

  it('REQ-LANDING-001: no em-dash or en-dash appears anywhere in the rendered copy', () => {
    expect(text).not.toMatch(/[–—]/);
  });
});

describe('landing page metadata (REQ-LANDING-003)', () => {
  const requiredOgTags = [
    'og:type',
    'og:site_name',
    'og:title',
    'og:description',
    'og:url',
    'og:image',
    'og:image:width',
    'og:image:height',
    'og:image:alt',
    'og:locale',
  ];

  it('REQ-LANDING-003: exposes the full Open Graph tag set with correct image dimensions', () => {
    for (const tag of requiredOgTags) {
      expect(html).toContain(`property="${tag}"`);
    }
    expect(html).toContain('content="1200"');
    expect(html).toContain('content="630"');
  });

  it('REQ-LANDING-003: exposes Twitter summary_large_image card metadata', () => {
    expect(html).toContain('name="twitter:card"');
    expect(html).toContain('content="summary_large_image"');
    expect(html).toContain('name="twitter:title"');
    expect(html).toContain('name="twitter:description"');
    expect(html).toContain('name="twitter:image"');
    expect(html).toContain('name="twitter:image:alt"');
  });

  it('REQ-LANDING-003: canonical URL points to the served root, not the /landing asset path', () => {
    expect(html).toContain('rel="canonical" href="https://codeflare.ch/"');
  });

  it('REQ-LANDING-003: meta description contains the enterprise positioning phrase', () => {
    expect(html).toMatch(/<meta name="description" content="[^"]*agentic coding engine[^"]*"/);
  });

  it('REQ-LANDING-003: emits a valid JSON-LD graph naming the Organization, WebSite, and SoftwareApplication', () => {
    const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const data = JSON.parse(match![1]) as { '@graph': Array<Record<string, unknown>> };
    const types = data['@graph'].map((node) => node['@type']);
    expect(types).toContain('Organization');
    expect(types).toContain('WebSite');
    // The home page grafts on the product entity.
    expect(types).toContain('SoftwareApplication');
    const org = data['@graph'].find((node) => node['@type'] === 'Organization') as
      | { name?: string; sameAs?: string[] }
      | undefined;
    expect(org?.name).toBe('Codeflare');
    expect(org?.sameAs).toContain('https://github.com/nikolanovoselec/codeflare');
  });

  it('REQ-LANDING-003: declares a theme-color and an apple-touch-icon for mobile share/install surfaces', () => {
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('rel="apple-touch-icon"');
  });
});

describe('privacy page (REQ-LANDING-002)', () => {
  it('REQ-LANDING-002: privacy policy renders with the no-storage contact form disclosure', async () => {
    const container = await AstroContainer.create();
    const privacyHtml = await container.renderToString(PrivacyPage);

    expect(privacyHtml).toContain('Privacy');
    expect(privacyHtml).toContain('Turnstile');
    // The load-bearing claim: submissions are relayed as email, not persisted.
    expect(privacyHtml.toLowerCase()).toContain('not stored');
  });
});
