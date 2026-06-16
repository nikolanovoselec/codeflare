import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@solidjs/testing-library';
import PerGroupRoutingCard from '../../components/setup/PerGroupRoutingCard';

afterEach(() => cleanup());

const base = {
  groupName: 'team_a',
  availableRoutes: ['development', 'prod'],
  selectedRoutes: [] as string[],
  defaultRoute: '',
  reasoning: 'off' as const,
  onToggleRoute: () => {},
  onDefaultChange: () => {},
  onReasoningChange: () => {},
  onApplyToAll: () => {},
};

const applyBtn = () => document.querySelector('.group-routing-card-header button');

describe('PerGroupRoutingCard', () => {
  it('renders a route pill per available route', () => {
    render(() => <PerGroupRoutingCard {...base} />);
    expect(document.querySelectorAll('.pill').length).toBe(2);
  });

  it('marks selected routes on and the rest off', () => {
    render(() => <PerGroupRoutingCard {...base} selectedRoutes={['prod']} />);
    expect(document.querySelector('[data-value="development"]')?.getAttribute('data-state')).toBe('off');
    expect(document.querySelector('[data-value="prod"]')?.getAttribute('data-state')).toBe('on');
  });

  it('calls onToggleRoute with the route on pill click', () => {
    const onToggleRoute = vi.fn();
    render(() => <PerGroupRoutingCard {...base} onToggleRoute={onToggleRoute} />);
    fireEvent.click(document.querySelector('[data-value="development"]')!);
    expect(onToggleRoute).toHaveBeenCalledWith('development');
  });

  it('hides the default/reasoning selectors when no routes are selected', () => {
    render(() => <PerGroupRoutingCard {...base} selectedRoutes={[]} />);
    expect(document.querySelector('.route-default-row')).toBeNull();
  });

  it('constrains the default-route options to the selected routes', () => {
    render(() => <PerGroupRoutingCard {...base} selectedRoutes={['prod']} defaultRoute="prod" />);
    const sel = document.querySelectorAll('.route-select')[0] as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['prod']);
  });

  it('disables the reasoning selector when there is no default route', () => {
    render(() => <PerGroupRoutingCard {...base} selectedRoutes={['prod']} defaultRoute="" />);
    const reasoningSel = document.querySelectorAll('.route-select')[1] as HTMLSelectElement;
    expect(reasoningSel.disabled).toBe(true);
  });

  it('shows the Apply-to-all control only when showApplyToAll is set, and fires it', () => {
    const onApplyToAll = vi.fn();

    render(() => <PerGroupRoutingCard {...base} onApplyToAll={onApplyToAll} showApplyToAll />);
    expect(applyBtn()).not.toBeNull();
    fireEvent.click(applyBtn()!);
    expect(onApplyToAll).toHaveBeenCalledTimes(1);
  });

  it('hides the Apply-to-all control when showApplyToAll is falsy', () => {
    render(() => <PerGroupRoutingCard {...base} />);
    expect(applyBtn()).toBeNull();
  });
});
