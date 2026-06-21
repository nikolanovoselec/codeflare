/**
 * REQ-AGENT-004 AC3: session-mode selection (Standard / Pro) is available in the
 * Settings session-defaults area. SessionSection is the component composed into the
 * "Session Defaults" accordion of SettingsPanel; it owns the mode-selection control.
 *
 * The control is the source of truth for AC3, so these tests render SessionSection
 * directly and assert the control's presence, structure, and selection contract.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import SessionSection from '../../../components/settings/SessionSection';

// isTouchDevice gates the desktop-only clipboard row; pin it to desktop so the
// section renders deterministically regardless of the jsdom touch surface.
vi.mock('../../../lib/mobile', () => ({
  isTouchDevice: () => false,
}));

type ModeChange = (mode: 'default' | 'advanced') => void;

function renderSection(overrides: {
  saasMode?: boolean;
  currentSessionMode?: 'default' | 'advanced';
  canUseAdvanced?: boolean;
  onSessionModeChange?: ModeChange;
} = {}) {
  const props = {
    enterpriseMode: () => false,
    saasMode: () => overrides.saasMode ?? true,
    currentSessionMode: () => overrides.currentSessionMode ?? 'default',
    canUseAdvanced: () => overrides.canUseAdvanced ?? true,
    fastStartEnabled: () => true,
    workspaceSyncEnabled: () => false,
    clipboardAccess: () => false,
    sleepAfter: () => '30m',
    canChangeSleepAfter: () => true,
    isFreeUser: () => false,
    recreateDocsLoading: () => false,
    recreateDocsMessage: () => null,
    recreateDocsError: () => null,
    recreateAgentLoading: () => false,
    recreateAgentMessage: () => null,
    recreateAgentError: () => null,
    onSessionModeChange: overrides.onSessionModeChange ?? (() => {}),
    onFastStartToggle: () => {},
    onWorkspaceSyncToggle: () => {},
    onSleepAfterChange: () => {},
    onRecreateDocs: () => {},
    onRecreateAgentConfigs: () => {},
    updateSetting: () => {},
  } as const;
  // Cast: the typed Accessor<...> props are satisfied by these zero-arg getters.
  render(() => <SessionSection {...(props as unknown as Parameters<typeof SessionSection>[0])} />);
}

describe('REQ-AGENT-004 AC3: mode selection in Settings session-defaults', () => {
  afterEach(() => cleanup());

  it('renders the Standard/Pro mode-selection control as a radiogroup with both options', () => {
    renderSection({ saasMode: true });

    const control = screen.getByTestId('session-mode-control');
    expect(control).toBeInTheDocument();
    expect(control).toHaveAttribute('role', 'radiogroup');

    const standard = screen.getByTestId('session-mode-default') as HTMLInputElement;
    const pro = screen.getByTestId('session-mode-advanced') as HTMLInputElement;
    expect(standard).toHaveAttribute('type', 'radio');
    expect(pro).toHaveAttribute('type', 'radio');
    expect(standard.name).toBe('session-mode');
    expect(pro.name).toBe('session-mode');
    expect(standard.value).toBe('default');
    expect(pro.value).toBe('advanced');
  });

  it('reflects the current mode as the checked radio', () => {
    renderSection({ saasMode: true, currentSessionMode: 'advanced' });

    expect((screen.getByTestId('session-mode-advanced') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('session-mode-default') as HTMLInputElement).checked).toBe(false);
  });

  it('disables the Pro option when the user cannot use advanced mode', () => {
    renderSection({ saasMode: true, canUseAdvanced: false });

    expect((screen.getByTestId('session-mode-advanced') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('session-mode-default') as HTMLInputElement).disabled).toBe(false);
  });

  it('invokes onSessionModeChange with the selected mode', () => {
    const onSessionModeChange = vi.fn();
    renderSection({ saasMode: true, currentSessionMode: 'default', onSessionModeChange });

    fireEvent.change(screen.getByTestId('session-mode-advanced'));

    expect(onSessionModeChange).toHaveBeenCalledWith('advanced');
  });

  it('does not render the mode-selection control outside SaaS mode', () => {
    renderSection({ saasMode: false });

    expect(screen.queryByTestId('session-mode-control')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-mode-default')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-mode-advanced')).not.toBeInTheDocument();
  });
});
