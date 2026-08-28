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
import { mdiConsoleLine } from '@mdi/js';
import SessionSection from '../../../components/settings/SessionSection';

// isTouchDevice gates the desktop-only clipboard row; pin it to desktop so the
// section renders deterministically regardless of the jsdom touch surface.
vi.mock('../../../lib/mobile', () => ({
  isTouchDevice: () => false,
}));

type ModeChange = (mode: 'default' | 'advanced') => void;

function renderSection(overrides: {
  enterpriseMode?: boolean;
  saasMode?: boolean;
  currentSessionMode?: 'default' | 'advanced';
  defaultWorkspace?: 'terminal' | 'vscode';
  canUseAdvanced?: boolean;
  canChangeSleepAfter?: boolean;
  onSessionModeChange?: ModeChange;
  onDefaultWorkspaceChange?: (workspace: 'terminal' | 'vscode') => void;
  herdrEnabled?: boolean;
  onHerdrToggle?: () => void;
} = {}) {
  const props = {
    enterpriseMode: () => overrides.enterpriseMode ?? false,
    saasMode: () => overrides.saasMode ?? true,
    currentSessionMode: () => overrides.currentSessionMode ?? 'default',
    defaultWorkspace: () => overrides.defaultWorkspace ?? 'terminal',
    canUseAdvanced: () => overrides.canUseAdvanced ?? true,
    fastStartEnabled: () => true,
    herdrEnabled: () => overrides.herdrEnabled ?? false,
    workspaceSyncEnabled: () => false,
    clipboardAccess: () => false,
    notificationPermission: () => 'default' as const,
    sleepAfter: () => '30m',
    canChangeSleepAfter: () => overrides.canChangeSleepAfter ?? true,
    isFreeUser: () => false,
    recreateDocsLoading: () => false,
    recreateDocsMessage: () => null,
    recreateDocsError: () => null,
    recreateAgentLoading: () => false,
    recreateAgentMessage: () => null,
    recreateAgentError: () => null,
    onSessionModeChange: overrides.onSessionModeChange ?? (() => {}),
    onDefaultWorkspaceChange: overrides.onDefaultWorkspaceChange ?? (() => {}),
    onFastStartToggle: () => {},
    onHerdrToggle: overrides.onHerdrToggle ?? (() => {}),
    onWorkspaceSyncToggle: () => {},
    onEnableAgentNotifications: () => {},
    onSleepAfterChange: () => {},
    onRecreateDocs: () => {},
    onRecreateAgentConfigs: () => {},
    updateSetting: () => {},
  } as const;
  // Cast: the typed Accessor<...> props are satisfied by these zero-arg getters.
  render(() => <SessionSection {...(props as unknown as Parameters<typeof SessionSection>[0])} />);
}

describe('terminal experience preference', () => {
  afterEach(() => cleanup());

  it('defaults off and invokes the server-preference toggle', () => {
    const onHerdrToggle = vi.fn();
    renderSection({ onHerdrToggle });
    const toggle = screen.getByTestId('settings-herdr-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(onHerdrToggle).toHaveBeenCalledOnce();
  });

  it('reflects an enabled preference', () => {
    renderSection({ herdrEnabled: true });
    expect(screen.getByTestId('settings-herdr-toggle')).toHaveAttribute('aria-checked', 'true');
  });

  it('REQ-TERM-034 AC5: explains Herdr and marks the terminal experience as beta', () => {
    renderSection();

    expect(screen.getByTestId('settings-herdr-icon').querySelector('path')).toHaveAttribute('d', mdiConsoleLine);
    expect(screen.getByTestId('settings-herdr-beta')).toHaveTextContent('beta');
    expect(screen.getByTestId('settings-herdr-hint')).toHaveTextContent(
      'Use Herdr for terminal workspaces, splits, panes, and built-in agent status. Leave off to use Codeflare’s standard terminal tabs and tiling. Applies to new sessions.',
    );
  });
});

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

describe('default workspace selection', () => {
  afterEach(() => cleanup());

  it('renders Terminal and VS Code controls for Advanced mode with Terminal selected by default', () => {
    renderSection({ currentSessionMode: 'advanced' });

    const control = screen.getByTestId('default-workspace-control');
    expect(control).toHaveAttribute('role', 'radiogroup');
    expect(screen.getByTestId('default-workspace-terminal')).toBeChecked();
    expect(screen.getByTestId('default-workspace-vscode')).not.toBeChecked();
  });

  it('hides workspace controls in Standard mode', () => {
    renderSection({ currentSessionMode: 'default' });

    expect(screen.queryByTestId('default-workspace-control')).not.toBeInTheDocument();
  });

  it('renders workspace controls for enterprise-forced Advanced mode', () => {
    renderSection({ enterpriseMode: true, currentSessionMode: 'default' });

    expect(screen.getByTestId('default-workspace-control')).toBeInTheDocument();
  });

  it('reports VS Code selection through preference callback', () => {
    const onDefaultWorkspaceChange = vi.fn();
    renderSection({ currentSessionMode: 'advanced', onDefaultWorkspaceChange });

    fireEvent.change(screen.getByTestId('default-workspace-vscode'));

    expect(onDefaultWorkspaceChange).toHaveBeenCalledWith('vscode');
  });
});

describe('REQ-SESSION-004 AC6: idle-timeout dropdown gating', () => {
  afterEach(() => cleanup());

  it('enables the sleep-after select when the user may change the idle timeout', () => {
    renderSection({ canChangeSleepAfter: true });

    expect((screen.getByTestId('settings-sleep-after-select') as HTMLSelectElement).disabled).toBe(false);
  });

  it('disables the sleep-after select when the user may not change the idle timeout', () => {
    renderSection({ canChangeSleepAfter: false });

    expect((screen.getByTestId('settings-sleep-after-select') as HTMLSelectElement).disabled).toBe(true);
  });
});
