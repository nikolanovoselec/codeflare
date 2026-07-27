import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ComponentProps } from 'solid-js';
import { render, cleanup, fireEvent } from '@solidjs/testing-library';
import { mdiCogOutline } from '@mdi/js';
import AdminActionButton from '../../components/settings/AdminActionButton';

afterEach(cleanup);

// AdminActionButton was extracted from five copies of the same markup across
// SettingsPanel and SessionSection, each carrying its own inline hex. These
// assertions are the migration oracle: structure and contract values only
// (class, tone token, disabled, testid, click), never the label copy.
describe('AdminActionButton', () => {
  const renderButton = (overrides: Partial<ComponentProps<typeof AdminActionButton>> = {}) =>
    render(() => (
      <AdminActionButton
        tone="--color-action-setup"
        icon={mdiCogOutline}
        label="Do the thing"
        onClick={() => {}}
        {...overrides}
      />
    ));

  it('renders one styled button carrying the icon and the label', () => {
    const { container } = renderButton();

    const buttons = container.querySelectorAll('button.provider-row-connect-btn');
    expect(buttons.length).toBe(1);
    expect(buttons[0].getAttribute('type')).toBe('button');
    expect(buttons[0].querySelectorAll('svg').length).toBe(1);
    expect(buttons[0].querySelectorAll('span').length).toBe(1);
  });

  it('takes its background from the tone token rather than a literal colour', () => {
    const { container } = renderButton({ tone: '--color-action-users' });

    const style = container.querySelector('button')?.getAttribute('style') ?? '';
    expect(style).toContain('var(--color-action-users)');
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('fires onClick when enabled and stays inert when disabled', () => {
    const onClick = vi.fn();
    const { container, unmount } = renderButton({ onClick });

    fireEvent.click(container.querySelector('button')!);
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();

    const disabled = renderButton({ onClick, disabled: true });
    const button = disabled.container.querySelector<HTMLButtonElement>('button')!;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
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
