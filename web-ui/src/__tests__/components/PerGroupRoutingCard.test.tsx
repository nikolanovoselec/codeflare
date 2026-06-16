import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
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

describe('PerGroupRoutingCard', () => {
  it('renders a checkbox per available route', () => {
    render(() => <PerGroupRoutingCard {...base} />);
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(2);
  });

  it('reflects selected routes as checked', () => {
    render(() => <PerGroupRoutingCard {...base} selectedRoutes={['prod']} />);
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes[0].checked).toBe(false); // development
    expect(boxes[1].checked).toBe(true);  // prod
  });

  it('calls onToggleRoute with the route on checkbox click', () => {
    const onToggleRoute = vi.fn();
    render(() => <PerGroupRoutingCard {...base} onToggleRoute={onToggleRoute} />);
    fireEvent.click(document.querySelectorAll('input[type="checkbox"]')[0]);
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

  it('fires onApplyToAll when the button is clicked', () => {
    const onApplyToAll = vi.fn();
    render(() => <PerGroupRoutingCard {...base} onApplyToAll={onApplyToAll} />);
    fireEvent.click(screen.getByText('Apply to all groups'));
    expect(onApplyToAll).toHaveBeenCalled();
  });
});
