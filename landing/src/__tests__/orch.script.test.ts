// @vitest-environment happy-dom
/**
 * Behavioral DOM tests for orch.ts (the orchestration section live feed).
 *
 * The visible behavior is: each agent row's activity line advances through its
 * real command list and its tool-use / token counters tick up, so the "Running
 * N agents" view reads as a review actually running rather than a screenshot.
 * These tests drive the exported feed functions against the DOM shape index.astro
 * renders and assert the mutation outcomes, so a no-op tick or a broken counter
 * update fails them.
 *
 * matchMedia is mocked to reduced=true so the module's auto-wiring (which would
 * construct an IntersectionObserver on import) is skipped; the feed functions are
 * exported and driven directly, which is the behavior under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function mockMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: reduced,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

/** Build the per-agent DOM shape index.astro renders: an agent row with its
 *  command list + counters, followed by a sibling activity line. */
function buildTerminal(activities: string[], toolUses: number, tokens: number): HTMLElement {
  document.body.innerHTML = `
    <div data-orch>
      <span class="t-line orch-agent-line" data-orch-agent data-activities='${JSON.stringify(activities)}'><span data-orch-tooluses>${toolUses}</span> tool uses · <span data-orch-tokens>${tokens.toFixed(1)}</span>k tokens</span>
      <span class="t-line orch-sub"><span data-orch-activity>${activities[0]}</span></span>
    </div>`;
  return document.querySelector('[data-orch]') as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // reduced=true so importing the module does not arm the IntersectionObserver
  // auto-wiring; the exported feed functions are driven directly below.
  mockMatchMedia(true);
});

afterEach(() => {
  vi.resetModules();
});

describe('orch.ts orchestration live feed (REQ-LANDING-001)', () => {
  it('collectAgents resolves each agent row with its command list, counters, and activity element', async () => {
    const term = buildTerminal(['read', 'grep', 'test'], 13, 45.0);
    const { collectAgents } = await import('../scripts/orch');

    const agents = collectAgents(term);
    expect(agents).toHaveLength(1);
    expect(agents[0].activities).toEqual(['read', 'grep', 'test']);
    expect(agents[0].activityEl.textContent).toBe('read');
    expect(agents[0].toolUsesEl.textContent).toBe('13');
    expect(agents[0].tokensEl.textContent).toBe('45.0');
  });

  it('tickAgent advances the activity through the command list and increments the counters', async () => {
    const term = buildTerminal(['read', 'grep', 'test'], 13, 45.0);
    const { collectAgents, tickAgent } = await import('../scripts/orch');
    const [agent] = collectAgents(term);

    tickAgent(agent);
    expect(agent.activityEl.textContent).toBe('grep');
    expect(agent.toolUsesEl.textContent).toBe('14');
    expect(agent.tokensEl.textContent).toBe('45.4');

    tickAgent(agent);
    expect(agent.activityEl.textContent).toBe('test');
    expect(agent.toolUsesEl.textContent).toBe('15');
    expect(agent.tokensEl.textContent).toBe('45.8');

    // Wraps back to the first activity so the feed never runs dry.
    tickAgent(agent);
    expect(agent.activityEl.textContent).toBe('read');
    expect(agent.toolUsesEl.textContent).toBe('16');
  });

  it('collectAgents skips a row with an empty command list or missing counters (no crash on partial markup)', async () => {
    document.body.innerHTML = `<div data-orch><span data-orch-agent data-activities='[]'></span></div>`;
    const term = document.querySelector('[data-orch]') as HTMLElement;
    const { collectAgents } = await import('../scripts/orch');

    expect(collectAgents(term)).toHaveLength(0);
  });
});
