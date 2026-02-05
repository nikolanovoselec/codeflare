import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';

// Mock dependencies
vi.mock('../../lib/mobile', () => ({
  isTouchDevice: vi.fn(() => false),
}));

vi.mock('../../lib/use-scramble-text', () => ({
  useScrambleText: (accessor: () => string) => accessor,
}));

vi.mock('../../lib/quotes', () => ({
  DEV_QUOTES: [
    { text: 'Quote 1', author: 'Author 1' },
    { text: 'Quote 2', author: 'Author 2' },
  ],
}));

vi.mock('../../lib/format', () => ({
  formatRelativeTime: vi.fn(() => '5 minutes ago'),
}));

vi.mock('../../lib/settings', () => ({
  loadSettings: vi.fn(() => ({ showTips: true })),
}));

vi.mock('../../components/Icon', () => ({
  default: (props: any) => <svg data-testid="icon" data-path={props.path} />
}));

import DashboardCard from '../../components/TipsRotator';

describe('TipsRotator (DashboardCard)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the tips card with data-testid', () => {
    render(() => <DashboardCard />);

    expect(screen.getByTestId('tips-card')).toBeInTheDocument();
  });

  it('renders TIPS & TRICKS header', () => {
    render(() => <DashboardCard />);

    expect(screen.getByText('TIPS & TRICKS')).toBeInTheDocument();
  });

  it('displays tip text content', () => {
    render(() => <DashboardCard />);

    const card = screen.getByTestId('tips-card');
    const content = card.querySelector('.dashboard-card__content');
    expect(content).toBeInTheDocument();
    expect(content?.textContent).toBeTruthy();
  });

  it('advances tip on click', () => {
    render(() => <DashboardCard />);

    const card = screen.getByTestId('tips-card');
    const textBefore = card.querySelector('.dashboard-card__text')?.textContent;

    fireEvent.click(card);

    const textAfter = card.querySelector('.dashboard-card__text')?.textContent;
    // Text should change after click (advances to next tip)
    expect(textAfter).not.toBe(textBefore);
  });

  it('renders an icon in the header', () => {
    render(() => <DashboardCard />);

    const icon = screen.getByTestId('tips-card').querySelector('[data-testid="icon"]');
    expect(icon).toBeInTheDocument();
  });
});
