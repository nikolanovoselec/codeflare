import { describe, expect, it } from 'vitest';

import {
  renderReviewWidgetLines,
  type ReviewWidgetAgent,
} from '../../../preseed/agents/pi/extensions/review-widget-renderer';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const NOW = Date.parse('2026-07-16T09:30:00.000Z');

function agent(overrides: Partial<ReviewWidgetAgent>): ReviewWidgetAgent {
  return {
    id: 'agent-1',
    label: 'Code review',
    description: 'PR 7138d93c',
    status: 'queued',
    toolUses: 0,
    startedAt: NOW,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

describe('REQ-AGENT-071: stock-derived review widget renderer', () => {
  it('renders lifecycle metrics and spinner frames without exceeding a mobile terminal width', () => {
    const agents = [
      agent({
        status: 'running',
        toolUses: 5,
        startedAt: NOW - 32_500,
        lifetimeUsage: { input: 12_000, output: 2_000, cacheWrite: 1_000 },
        compactionCount: 2,
      }),
      agent({ id: 'agent-2', label: 'Specification review' }),
      agent({
        id: 'agent-3',
        label: 'Documentation review',
        status: 'completed',
        completedAt: NOW,
        startedAt: NOW - 10_000,
      }),
    ];

    const first = renderReviewWidgetLines({ agents, spinnerFrame: 0, terminalWidth: 55, theme, now: NOW });
    const second = renderReviewWidgetLines({ agents, spinnerFrame: 1, terminalWidth: 55, theme, now: NOW });
    const wide = renderReviewWidgetLines({ agents, spinnerFrame: 0, terminalWidth: 120, theme, now: NOW });

    expect(first.every((line) => Array.from(line).length <= 55)).toBe(true);
    expect(wide.some((line) => line.includes('5 tool uses'))).toBe(true);
    expect(wide.some((line) => line.includes('15.0k token'))).toBe(true);
    expect(wide.some((line) => line.includes('↻2'))).toBe(true);
    expect(first.some((line) => line.includes('1 queued'))).toBe(true);
    expect(first.some((line) => line.includes('Documentation review'))).toBe(true);
    expect(first[1]).not.toBe(second[1]);
  });

  it('prioritizes active work and caps the widget body', () => {
    const agents = Array.from({ length: 16 }, (_, index) => agent({
      id: `agent-${index}`,
      label: `Review ${index}`,
      status: index < 3 ? 'running' : 'completed',
      completedAt: index < 3 ? undefined : NOW,
    }));

    const lines = renderReviewWidgetLines({ agents, spinnerFrame: 0, terminalWidth: 80, theme, now: NOW });

    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.slice(1, 4).every((line) => line.includes('running'))).toBe(true);
    expect(lines.at(-1)).toMatch(/more/);
  });
});
