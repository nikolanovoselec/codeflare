/**
 * Orchestration station live feed. The "Running N agents" tree renders its
 * resolved tool-use / token counters and first activity server-side, so it is
 * fully legible with no JavaScript and under reduced motion. This module makes
 * it read as a review actually running: each agent's activity line advances
 * through its real command list and its counters tick up, while the station is
 * on screen.
 *
 * Reduced motion: do nothing. The server-rendered values are the resolved state.
 * Off-screen or hidden tab: pause, so the counters do not race while unseen.
 *
 * The per-agent DOM shape (from index.astro): an agent row [data-orch-agent]
 * carrying data-activities (a JSON command list) plus [data-orch-tooluses] and
 * [data-orch-tokens] counters, immediately followed by a sibling activity line
 * holding [data-orch-activity].
 */
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const TICK_MS = 1900;
const TOKENS_PER_TICK = 0.4;

export interface OrchAgent {
  activityEl: HTMLElement;
  toolUsesEl: HTMLElement;
  tokensEl: HTMLElement;
  activities: string[];
  ai: number;
}

/** Resolve the live agents in one orchestration terminal from its DOM. */
export function collectAgents(terminal: HTMLElement): OrchAgent[] {
  const rows = Array.from(terminal.querySelectorAll<HTMLElement>('[data-orch-agent]'));
  const agents: OrchAgent[] = [];
  for (const row of rows) {
    const toolUsesEl = row.querySelector<HTMLElement>('[data-orch-tooluses]');
    const tokensEl = row.querySelector<HTMLElement>('[data-orch-tokens]');
    const activityEl =
      row.nextElementSibling?.querySelector<HTMLElement>('[data-orch-activity]') ?? null;
    let activities: string[] = [];
    try {
      activities = JSON.parse(row.getAttribute('data-activities') ?? '[]');
    } catch {
      activities = [];
    }
    if (!toolUsesEl || !tokensEl || !activityEl || activities.length === 0) continue;
    agents.push({ activityEl, toolUsesEl, tokensEl, activities, ai: 0 });
  }
  return agents;
}

/** Advance one agent a single beat: next activity, one more tool use, a little
 *  more spend. Deterministic, so the feed reads as steady progress. */
export function tickAgent(agent: OrchAgent): void {
  agent.ai = (agent.ai + 1) % agent.activities.length;
  agent.activityEl.textContent = agent.activities[agent.ai];
  const uses = Number(agent.toolUsesEl.textContent ?? '0') + 1;
  agent.toolUsesEl.textContent = String(uses);
  const tokens = Number(agent.tokensEl.textContent ?? '0') + TOKENS_PER_TICK;
  agent.tokensEl.textContent = tokens.toFixed(1);
}

if (!reduced) {
  for (const terminal of Array.from(document.querySelectorAll<HTMLElement>('[data-orch]'))) {
    const agents = collectAgents(terminal);
    if (agents.length === 0) continue;

    let onScreen = !('IntersectionObserver' in window);
    let started = false;

    const start = () => {
      if (started) return;
      started = true;
      agents.forEach((agent, i) => {
        // Stagger each agent so they never tick in lockstep.
        window.setInterval(() => {
          if (document.hidden || !onScreen) return;
          tickAgent(agent);
        }, TICK_MS + i * 230);
      });
    };

    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            onScreen = entry.isIntersecting;
            if (onScreen) start();
          }
        },
        { rootMargin: '-40px 0px -40px 0px' }
      );
      obs.observe(terminal);
    } else {
      start();
    }
  }
}
