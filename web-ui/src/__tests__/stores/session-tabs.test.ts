import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../stores/tiling', () => ({
  LAYOUT_MIN_TABS: { tabbed: 1, '2-split': 2, '3-split': 3, '4-grid': 4 },
  getBestLayoutForTabCount: vi.fn((count: number) => {
    if (count >= 4) return '4-grid';
    if (count >= 3) return '3-split';
    if (count >= 2) return '2-split';
    return 'tabbed';
  }),
  isLayoutCompatible: vi.fn((layout: string, count: number) => {
    const min: Record<string, number> = { tabbed: 1, '2-split': 2, '3-split': 3, '4-grid': 4 };
    return count >= (min[layout] || 1);
  }),
}));

vi.mock('../../lib/constants', () => ({
  MAX_TERMINALS_PER_SESSION: 6,
}));

import {
  registerTabsDeps,
  initializeTerminalsForSession,
  addTerminalTab,
  removeTerminalTab,
  setActiveTerminalTab,
  getTerminalsForSession,
  reorderTerminalTabs,
  cleanupTerminalsForSession,
  loadTerminalsFromStorage,
  saveTerminalsToStorage,
} from '../../stores/session-tabs';

describe('session-tabs store', () => {
  let state: { terminalsPerSession: Record<string, any> };
  const getState = () => state;
  const setState = (fn: (s: typeof state) => void) => { fn(state); };
  const saveFn = vi.fn();
  const terminalRef = {
    dispose: vi.fn(),
    disposeSession: vi.fn(),
    triggerLayoutResize: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    state = { terminalsPerSession: {} };
    registerTabsDeps(getState, setState, terminalRef, saveFn);
  });

  describe('initializeTerminalsForSession', () => {
    it('creates default terminals for a new session', () => {
      initializeTerminalsForSession('sess1');

      const terminals = state.terminalsPerSession['sess1'];
      expect(terminals).toBeTruthy();
      expect(terminals.tabs).toHaveLength(1);
      expect(terminals.tabs[0].id).toBe('1');
      expect(terminals.activeTabId).toBe('1');
      expect(terminals.tabOrder).toEqual(['1']);
      expect(saveFn).toHaveBeenCalled();
    });

    it('normalizes existing terminals if already present', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '2', createdAt: '' }, { id: '1', createdAt: '' }],
        activeTabId: '2',
        tabOrder: ['2', '1'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      initializeTerminalsForSession('sess1');

      // Tab 1 should be normalized to first position
      expect(state.terminalsPerSession['sess1'].tabOrder[0]).toBe('1');
    });

    it('restores from localStorage if not in state', () => {
      const stored = {
        'sess1': {
          tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
          activeTabId: '1',
          tabOrder: ['1', '2'],
          tiling: { enabled: false, layout: 'tabbed' },
        },
      };
      localStorage.setItem('codeflare:terminalsPerSession', JSON.stringify(stored));

      initializeTerminalsForSession('sess1');

      expect(state.terminalsPerSession['sess1'].tabs).toHaveLength(2);
    });
  });

  describe('addTerminalTab', () => {
    it('adds a new tab and sets it as active', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      const newId = addTerminalTab('sess1');

      expect(newId).toBe('2');
      expect(state.terminalsPerSession['sess1'].tabs).toHaveLength(2);
      expect(state.terminalsPerSession['sess1'].activeTabId).toBe('2');
    });

    it('returns null when max terminals reached', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), createdAt: '' })),
        activeTabId: '1',
        tabOrder: ['1', '2', '3', '4', '5', '6'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      const result = addTerminalTab('sess1');

      expect(result).toBeNull();
    });

    it('reverts to tabbed when new tab exceeds tiling layout slots', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: true, layout: '2-split' },
      };

      addTerminalTab('sess1');

      // 3 tabs exceeds 2-split (2 slots), should revert to tabbed
      expect(state.terminalsPerSession['sess1'].tiling.enabled).toBe(false);
      expect(state.terminalsPerSession['sess1'].tiling.layout).toBe('tabbed');
    });
  });

  describe('removeTerminalTab', () => {
    it('removes a non-primary tab', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
        activeTabId: '2',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      const result = removeTerminalTab('sess1', '2');

      expect(result).toBe(true);
      expect(state.terminalsPerSession['sess1'].tabs).toHaveLength(1);
      expect(terminalRef.dispose).toHaveBeenCalledWith('sess1', '2');
    });

    it('refuses to remove tab 1', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      const result = removeTerminalTab('sess1', '1');

      expect(result).toBe(false);
      expect(state.terminalsPerSession['sess1'].tabs).toHaveLength(2);
    });

    it('switches active tab to first remaining tab when active is removed', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
        activeTabId: '2',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      removeTerminalTab('sess1', '2');

      expect(state.terminalsPerSession['sess1'].activeTabId).toBe('1');
    });
  });

  describe('setActiveTerminalTab', () => {
    it('sets the active tab for a session', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      setActiveTerminalTab('sess1', '2');

      expect(state.terminalsPerSession['sess1'].activeTabId).toBe('2');
      expect(saveFn).toHaveBeenCalled();
    });
  });

  describe('getTerminalsForSession', () => {
    it('returns terminals when session exists', () => {
      const terminals = {
        tabs: [{ id: '1', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1'],
        tiling: { enabled: false, layout: 'tabbed' },
      };
      state.terminalsPerSession['sess1'] = terminals;

      expect(getTerminalsForSession('sess1')).toEqual(terminals);
    });

    it('returns null for unknown session', () => {
      expect(getTerminalsForSession('unknown')).toBeNull();
    });
  });

  describe('reorderTerminalTabs', () => {
    it('reorders tabs when valid', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }, { id: '3', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1', '2', '3'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      const result = reorderTerminalTabs('sess1', ['1', '3', '2']);

      expect(result).toBe(true);
      expect(state.terminalsPerSession['sess1'].tabOrder).toEqual(['1', '3', '2']);
    });

    it('rejects reorder when tab 1 is not first', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      const result = reorderTerminalTabs('sess1', ['2', '1']);

      expect(result).toBe(false);
    });

    it('rejects reorder with mismatched tab IDs', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }, { id: '2', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1', '2'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      const result = reorderTerminalTabs('sess1', ['1', '3']);

      expect(result).toBe(false);
    });
  });

  describe('cleanupTerminalsForSession', () => {
    it('disposes session and removes from state', () => {
      state.terminalsPerSession['sess1'] = {
        tabs: [{ id: '1', createdAt: '' }],
        activeTabId: '1',
        tabOrder: ['1'],
        tiling: { enabled: false, layout: 'tabbed' },
      };

      cleanupTerminalsForSession('sess1');

      expect(terminalRef.disposeSession).toHaveBeenCalledWith('sess1');
      expect(state.terminalsPerSession['sess1']).toBeUndefined();
      expect(saveFn).toHaveBeenCalled();
    });
  });

  describe('localStorage persistence', () => {
    it('saveTerminalsToStorage writes to localStorage', () => {
      const data = {
        'sess1': {
          tabs: [{ id: '1', createdAt: '' }],
          activeTabId: '1',
          tabOrder: ['1'],
          tiling: { enabled: false, layout: 'tabbed' as const },
        },
      };

      saveTerminalsToStorage(data);

      const stored = localStorage.getItem('codeflare:terminalsPerSession');
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored!)).toEqual(data);
    });

    it('loadTerminalsFromStorage reads and normalizes', () => {
      const data = {
        'sess1': {
          tabs: [{ id: '1', createdAt: '' }],
          activeTabId: '1',
          tabOrder: ['1'],
          tiling: { enabled: false, layout: 'tabbed' },
        },
      };
      localStorage.setItem('codeflare:terminalsPerSession', JSON.stringify(data));

      const result = loadTerminalsFromStorage();

      expect(result['sess1']).toBeTruthy();
      expect(result['sess1'].tabs[0].id).toBe('1');
    });

    it('loadTerminalsFromStorage returns empty object on invalid JSON', () => {
      localStorage.setItem('codeflare:terminalsPerSession', 'not-json');

      const result = loadTerminalsFromStorage();

      expect(result).toEqual({});
    });
  });
});
