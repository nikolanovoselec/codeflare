import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@solidjs/testing-library';

// Controllable usage payload returned by the mocked getUsage() API call.
// formatDuration() turns these second-counts into the contract strings the
// stat cards / bar labels render, and usagePercent() derives the ring fill.
let mockUsage: {
  dailySeconds: number;
  monthlySeconds: number;
  monthlyQuotaSeconds: number | null;
  tierId: string;
  tier: string;
  mode?: 'default' | 'advanced';
};
let mockGetUsageRejects = false;

vi.mock('../../api/client', () => ({
  getUsage: vi.fn(async () => {
    if (mockGetUsageRejects) throw new Error('boom');
    return mockUsage;
  }),
}));

// saasMode gates the optional "Subscription" action; the stat cards + ring do
// not depend on it. Keep it controllable so we can assert the gate separately.
let mockSaasMode = false;
vi.mock('../../stores/session', () => ({
  sessionStore: {
    get saasMode() { return mockSaasMode; },
  },
}));

// ScrambleText animates one character at a time; render the final text directly
// so assertions do not race the scramble timers.
vi.mock('../../components/ScrambleText', () => ({
  default: (props: any) => <span class={props.class}>{props.text}</span>,
}));

import UsagePage from '../../components/UsagePage';

describe('UsagePage / REQ-SUB-018 AC1 / REQ-SUB-022 AC4 (usage stat and quota rendering)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsageRejects = false;
    mockSaasMode = false;
    // 1h today, 10h this month, 40h quota -> 25% usage.
    mockUsage = {
      dailySeconds: 3600,
      monthlySeconds: 36_000,
      monthlyQuotaSeconds: 144_000,
      tierId: 'free',
      tier: 'Free',
      mode: 'default',
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the progress ring/bar with a fill width equal to the computed usage percent', async () => {
    render(() => <UsagePage />);

    await waitFor(() => expect(document.querySelector('.usage-bar-fill')).toBeInTheDocument());

    const fill = document.querySelector('.usage-bar-fill') as HTMLElement;
    // 36000 / 144000 = 25%. The fill width is a computed contract value, not copy.
    expect(fill.style.width).toBe('25%');
    // The percent readout reflects the same derived value.
    expect(document.querySelector('.usage-panel-percent')?.textContent).toBe('25%');
  });

  it('renders the three stat cards with their formatted numeric values', async () => {
    render(() => <UsagePage />);

    await waitFor(() => expect(document.querySelectorAll('.usage-panel-stat').length).toBe(3));

    const cards = Array.from(document.querySelectorAll('.usage-panel-stat'));
    const byLabel: Record<string, string> = {};
    for (const card of cards) {
      const label = card.querySelector('.usage-panel-stat-label')?.textContent ?? '';
      const value = card.querySelector('.usage-panel-stat-value')?.textContent ?? '';
      byLabel[label] = value;
    }

    // formatDuration contract: 3600s -> '1h', 36000s -> '10h', 144000s -> '40h'.
    expect(byLabel['Today']).toBe('1h');
    expect(byLabel['This month']).toBe('10h');
    expect(byLabel['Quota']).toBe('40h');
  });

  it('REQ-SUB-022 AC4: renders only personal usage times outside SaaS', async () => {
    mockUsage = { ...mockUsage, monthlyQuotaSeconds: null };

    render(() => <UsagePage />);

    await waitFor(() => expect(document.querySelectorAll('.usage-panel-stat').length).toBe(2));
    const labels = Array.from(document.querySelectorAll('.usage-panel-stat-label'))
      .map((label) => label.textContent);
    expect(labels).toEqual(['Today', 'This month']);
    expect(document.querySelector('.usage-bar-fill')).not.toBeInTheDocument();
    expect(document.querySelector('.usage-panel-percent')).not.toBeInTheDocument();
    expect(document.querySelector('.usage-panel-plan')).not.toBeInTheDocument();
  });

  it('REQ-SUB-018 AC7: centers the plan label for a metered SaaS tier', async () => {
    mockSaasMode = true;

    render(() => <UsagePage />);

    await waitFor(() => expect(document.querySelector('.usage-panel-plan')).toBeInTheDocument());
    const plan = document.querySelector('.usage-panel-plan') as HTMLElement;
    expect(plan.textContent).toBe('Free Standard');
    expect(plan.parentElement).toHaveClass('usage-panel-header--centered-plan');
  });

  it('REQ-SUB-018 AC7: hides the plan label for the custom SaaS tier', async () => {
    mockSaasMode = true;
    mockUsage = {
      ...mockUsage,
      tierId: 'unlimited',
      tier: 'Custom',
    };

    render(() => <UsagePage />);

    await waitFor(() => expect(document.querySelector('.usage-panel-percent')).toBeInTheDocument());
    expect(document.querySelector('.usage-panel-plan')).not.toBeInTheDocument();
  });

  it('shows the error surface instead of stat cards when getUsage rejects', async () => {
    mockGetUsageRejects = true;

    render(() => <UsagePage />);

    await waitFor(() => expect(document.querySelector('.usage-error')).toBeInTheDocument());
    expect(document.querySelectorAll('.usage-panel-stat').length).toBe(0);
    expect(document.querySelector('.usage-bar-fill')).not.toBeInTheDocument();
  });
});
