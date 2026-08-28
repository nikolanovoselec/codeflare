import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerTabsDeps,
  updateTerminalLabel,
} from '../../stores/session-tabs';
import type { SessionTerminals, TerminalTab } from '../../types';

/**
 * REQ-TERM-009 AC7: process name updates are reflected in the tab store via
 * updateTerminalLabel(sessionId, terminalId, processName).
 *
 * Replaces the text-matching audit in terminal-process-name.test.ts for AC7.
 * This test imports the real exported function from session-tabs.ts and
 * exercises it against an in-memory state container — the same shape the
 * production session store passes in via registerTabsDeps().
 */

type TestState = { terminalsPerSession: Record<string, SessionTerminals> };

function makeTab(id: string, processName?: string): TerminalTab {
  return { id, createdAt: '2026-01-01T00:00:00.000Z', processName };
}

function newState(): TestState {
  return {
    terminalsPerSession: {
      'sess-abc12345': {
        tabs: [makeTab('1'), makeTab('2')],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      },
    },
  };
}

describe('REQ-TERM-009 AC7: updateTerminalLabel writes processName to the targeted tab', () => {
  let state: TestState;

  beforeEach(() => {
    state = newState();
    registerTabsDeps(
      () => state,
      (mutator) => mutator(state),
      {
        dispose: () => {},
        disposeSession: () => {},
        triggerLayoutResize: () => {},
      },
      () => {},
    );
  });

  it('REQ-TERM-009 AC7: sets processName on the matching tab', () => {
    updateTerminalLabel('sess-abc12345', '1', 'claude');
    const tab = state.terminalsPerSession['sess-abc12345'].tabs.find((t) => t.id === '1');
    expect(tab?.processName).toBe('claude');
  });

  it('REQ-TERM-009 AC7: overwrites a previous processName on subsequent calls', () => {
    updateTerminalLabel('sess-abc12345', '1', 'bash');
    updateTerminalLabel('sess-abc12345', '1', 'claude');
    const tab = state.terminalsPerSession['sess-abc12345'].tabs.find((t) => t.id === '1');
    expect(tab?.processName).toBe('claude');
  });

  it('REQ-TERM-009 AC7: only mutates the targeted terminalId, leaves siblings untouched', () => {
    updateTerminalLabel('sess-abc12345', '2', 'codex');
    const tab1 = state.terminalsPerSession['sess-abc12345'].tabs.find((t) => t.id === '1');
    const tab2 = state.terminalsPerSession['sess-abc12345'].tabs.find((t) => t.id === '2');
    expect(tab1?.processName).toBeUndefined();
    expect(tab2?.processName).toBe('codex');
  });

  it('REQ-TERM-009 AC7: is a no-op when the session does not exist', () => {
    expect(() => updateTerminalLabel('sess-missing', '1', 'claude')).not.toThrow();
    expect(state.terminalsPerSession['sess-abc12345'].tabs[0].processName).toBeUndefined();
  });

  it('REQ-TERM-009 AC7: is a no-op when the terminalId is unknown within the session', () => {
    updateTerminalLabel('sess-abc12345', '9', 'claude');
    const tab1 = state.terminalsPerSession['sess-abc12345'].tabs.find((t) => t.id === '1');
    const tab2 = state.terminalsPerSession['sess-abc12345'].tabs.find((t) => t.id === '2');
    expect(tab1?.processName).toBeUndefined();
    expect(tab2?.processName).toBeUndefined();
  });
});
