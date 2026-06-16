import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import { mdiPi } from '@mdi/js';
import ClonePickerOptionRow from '../../components/github/ClonePickerOptionRow';

afterEach(() => cleanup());

describe('ClonePickerOptionRow', () => {
  it('routes icon, label and description into their slots', () => {
    render(() => (
      <ClonePickerOptionRow icon={mdiPi} label="ai-news-digest" description="Running in Pi" onClick={() => {}} testId="row" />
    ));
    const row = screen.getByTestId('row');
    expect(row.querySelector('.clone-picker-option-icon path')?.getAttribute('d')).toBe(mdiPi);
    expect(row.querySelector('.clone-picker-option-label')?.textContent).toContain('ai-news-digest');
    expect(row.querySelector('.clone-picker-option-desc')?.textContent).toBe('Running in Pi');
  });

  it('omits the description slot when none is given', () => {
    render(() => <ClonePickerOptionRow icon={mdiPi} label="x" onClick={() => {}} testId="row" />);
    expect(screen.getByTestId('row').querySelector('.clone-picker-option-desc')).toBeNull();
  });

  it('renders a badge slot only when a badge is provided', () => {
    render(() => <ClonePickerOptionRow icon={mdiPi} label="x" badge="beta" onClick={() => {}} testId="row" />);
    expect(screen.getByTestId('row').querySelector('.clone-picker-option-badge')?.textContent).toBe('beta');
  });

  it('carries sessionId and fires onClick', () => {
    const onClick = vi.fn();
    render(() => <ClonePickerOptionRow icon={mdiPi} label="x" onClick={onClick} testId="row" sessionId="sess-1" />);
    const row = screen.getByTestId('row');
    expect(row.getAttribute('data-session-id')).toBe('sess-1');
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
