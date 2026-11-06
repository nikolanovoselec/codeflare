import { describe, it, expect, afterEach } from 'vitest';
import { createSignal, type ComponentProps } from 'solid-js';
import { render, cleanup, fireEvent, screen } from '@solidjs/testing-library';
import { mdiCogOutline } from '@mdi/js';
import AdminActionButton from '../../components/settings/AdminActionButton';

afterEach(cleanup);

describe('AdminActionButton', () => {
  const renderButton = (overrides: Partial<ComponentProps<typeof AdminActionButton>> = {}) =>
    render(() => (
      <AdminActionButton
        icon={mdiCogOutline}
        label="Do the thing"
        onClick={() => {}}
        {...overrides}
      />
    ));

  it('exposes maintenance actions as named buttons without submitting a form', () => {
    renderButton();
    expect(screen.getByRole('button', { name: 'Do the thing' })).toHaveAttribute('type', 'button');
  });

  it('preserves the destination and accessible name for navigation rows', () => {
    renderButton({ href: '/admin', label: 'Open Administration' });
    expect(screen.getByRole('link', { name: 'Open Administration' })).toHaveAttribute('href', '/admin');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('activates the enabled action and leaves disabled actions inert', () => {
    const controls = (disabled: boolean) => {
      const [result, setResult] = createSignal('Ready');
      return render(() => <>
        <AdminActionButton icon={mdiCogOutline} label="Do the thing" disabled={disabled}
          onClick={() => setResult('Activated')} />
        <output aria-label="Action result">{result()}</output>
      </>);
    };
    const enabled = controls(false);
    fireEvent.click(screen.getByRole('button', { name: 'Do the thing' }));
    expect(screen.getByRole('status', { name: 'Action result' })).toHaveTextContent('Activated');
    enabled.unmount();

    controls(true);
    const button = screen.getByRole('button', { name: 'Do the thing' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.getByRole('status', { name: 'Action result' })).toHaveTextContent('Ready');
  });

  it('omits data-testid unless one is supplied', () => {
    const { container, unmount } = renderButton();
    expect(container.querySelector('button')?.hasAttribute('data-testid')).toBe(false);
    unmount();

    const tagged = renderButton({ testId: 'settings-do-the-thing' });
    expect(tagged.container.querySelector('button')?.getAttribute('data-testid')).toBe(
      'settings-do-the-thing'
    );
  });
});
