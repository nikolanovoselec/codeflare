import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock terminal store before importing session store
vi.mock('../../stores/terminal', () => ({
  terminalStore: {
    dispose: vi.fn(),
    disposeSession: vi.fn(),
    triggerLayoutResize: vi.fn(),
  },
  registerProcessNameCallback: vi.fn(),
}));

// Mock API client
vi.mock('../../api/client', () => ({
  getSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getBatchSessionStatus: vi.fn().mockResolvedValue({}),
  getStartupStatus: vi.fn().mockRejectedValue(new Error('Not found')),
  startSession: vi.fn(),
  stopSession: vi.fn(),
  getPresets: vi.fn().mockResolvedValue([]),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
  getPreferences: vi.fn().mockResolvedValue({}),
  updatePreferences: vi.fn().mockResolvedValue({}),
}));

// Import after mocks
import { sessionStore } from '../../stores/session';
import {
  LAYOUT_MIN_TABS,
  LAYOUT_UPGRADE_ORDER,
  getBestLayoutForTabCount,
  isLayoutCompatible,
  setTilingLayout,
  getTilingForSession,
  getTabOrder,
} from '../../stores/tiling';

describe('Tiling Module - Pure Helpers', () => {
  describe('LAYOUT_MIN_TABS', () => {
    it('should define minimum tab counts for each layout', () => {
      expect(LAYOUT_MIN_TABS['tabbed']).toBe(1);
      expect(LAYOUT_MIN_TABS['2-split']).toBe(2);
      expect(LAYOUT_MIN_TABS['3-split']).toBe(3);
      expect(LAYOUT_MIN_TABS['4-grid']).toBe(4);
    });
  });

  describe('LAYOUT_UPGRADE_ORDER', () => {
    it('should list layouts in upgrade order', () => {
      expect(LAYOUT_UPGRADE_ORDER).toEqual(['tabbed', '2-split', '3-split', '4-grid']);
    });
  });

  describe('getBestLayoutForTabCount', () => {
    it('should return tabbed for 1 tab', () => {
      expect(getBestLayoutForTabCount(1)).toBe('tabbed');
    });

    it('should return 2-split for 2 tabs', () => {
      expect(getBestLayoutForTabCount(2)).toBe('2-split');
    });

    it('should return 3-split for 3 tabs', () => {
      expect(getBestLayoutForTabCount(3)).toBe('3-split');
    });

    it('should return 4-grid for 4+ tabs', () => {
      expect(getBestLayoutForTabCount(4)).toBe('4-grid');
      expect(getBestLayoutForTabCount(6)).toBe('4-grid');
    });
  });

  describe('isLayoutCompatible', () => {
    it('should return true for compatible layouts', () => {
      expect(isLayoutCompatible('tabbed', 1)).toBe(true);
      expect(isLayoutCompatible('2-split', 3)).toBe(true);
      expect(isLayoutCompatible('4-grid', 4)).toBe(true);
    });

    it('should return false for incompatible layouts', () => {
      expect(isLayoutCompatible('2-split', 1)).toBe(false);
      expect(isLayoutCompatible('3-split', 2)).toBe(false);
      expect(isLayoutCompatible('4-grid', 3)).toBe(false);
    });
  });
});

describe('Tiling Module - Store Integration', () => {
  const mockSessionId = 'test-session-abc123';

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    try {
      sessionStore.cleanupTerminalsForSession(mockSessionId);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initializeTerminalsForSession', () => {
    it('should create default tabOrder with tab 1 first', () => {
      sessionStore.initializeTerminalsForSession(mockSessionId);

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals).not.toBeNull();
      expect(terminals!.tabOrder).toEqual(['1']);
    });

    it('should create default tiling state (disabled, tabbed layout)', () => {
      sessionStore.initializeTerminalsForSession(mockSessionId);

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals).not.toBeNull();
      expect(terminals!.tiling).toEqual({
        enabled: false,
        layout: 'tabbed',
      });
    });

    it('should persist tiling state to localStorage', () => {
      sessionStore.initializeTerminalsForSession(mockSessionId);

      const stored = localStorage.getItem('codeflare:terminalsPerSession');
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      expect(parsed[mockSessionId].tiling).toEqual({
        enabled: false,
        layout: 'tabbed',
      });
    });
  });

  describe('reorderTerminalTabs', () => {
    beforeEach(() => {
      sessionStore.initializeTerminalsForSession(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);
    });

    it('should maintain tab 1 in first position', () => {
      const result = sessionStore.reorderTerminalTabs(mockSessionId, ['2', '1', '3']);

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tabOrder[0]).toBe('1');
    });

    it('should allow reordering tabs 2+ while keeping tab 1 first', () => {
      const result = sessionStore.reorderTerminalTabs(mockSessionId, ['1', '3', '2']);

      expect(result).toBe(true);
      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tabOrder).toEqual(['1', '3', '2']);
    });

    it('should reject orders missing existing tabs', () => {
      const result = sessionStore.reorderTerminalTabs(mockSessionId, ['1', '2']);
      expect(result).toBe(false);
    });

    it('should reject orders with non-existent tabs', () => {
      const result = sessionStore.reorderTerminalTabs(mockSessionId, ['1', '2', '3', '4']);
      expect(result).toBe(false);
    });

    it('should persist new order to localStorage', () => {
      sessionStore.reorderTerminalTabs(mockSessionId, ['1', '3', '2']);

      const stored = localStorage.getItem('codeflare:terminalsPerSession');
      const parsed = JSON.parse(stored!);
      expect(parsed[mockSessionId].tabOrder).toEqual(['1', '3', '2']);
    });
  });

  describe('setTilingLayout', () => {
    beforeEach(() => {
      sessionStore.initializeTerminalsForSession(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId); // Now have 2 tabs
    });

    it('should enable tiling with specified layout', () => {
      setTilingLayout(mockSessionId, '2-split');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(true);
      expect(terminals!.tiling.layout).toBe('2-split');
    });

    it('should disable tiling when setting "tabbed" layout', () => {
      setTilingLayout(mockSessionId, '2-split');
      setTilingLayout(mockSessionId, 'tabbed');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(false);
      expect(terminals!.tiling.layout).toBe('tabbed');
    });

    it('should persist layout to localStorage', () => {
      setTilingLayout(mockSessionId, '2-split');

      const stored = localStorage.getItem('codeflare:terminalsPerSession');
      const parsed = JSON.parse(stored!);
      expect(parsed[mockSessionId].tiling).toEqual({
        enabled: true,
        layout: '2-split',
      });
    });

    it('should return false for incompatible layouts (not enough tabs)', () => {
      const result = setTilingLayout(mockSessionId, '3-split');

      expect(result).toBe(false);
      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(false);
    });

    it('should allow 2-split with exactly 2 tabs', () => {
      const result = setTilingLayout(mockSessionId, '2-split');
      expect(result).toBe(true);
    });

    it('should allow 3-split with 3+ tabs', () => {
      sessionStore.addTerminalTab(mockSessionId); // Now have 3 tabs

      const result = setTilingLayout(mockSessionId, '3-split');

      expect(result).toBe(true);
      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.layout).toBe('3-split');
    });

    it('should allow 4-grid with 4+ tabs', () => {
      sessionStore.addTerminalTab(mockSessionId); // 3 tabs
      sessionStore.addTerminalTab(mockSessionId); // 4 tabs

      const result = setTilingLayout(mockSessionId, '4-grid');

      expect(result).toBe(true);
      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.layout).toBe('4-grid');
    });
  });

  describe('removeTerminalTab - tiling auto-disable', () => {
    beforeEach(() => {
      sessionStore.initializeTerminalsForSession(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId); // 3 tabs total
    });

    it('should auto-downgrade tiling layout when removing makes current layout incompatible', () => {
      setTilingLayout(mockSessionId, '3-split');
      sessionStore.removeTerminalTab(mockSessionId, '3');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(true);
      expect(terminals!.tiling.layout).toBe('2-split');
    });

    it('should fully disable tiling when removing leaves only 1 tab', () => {
      setTilingLayout(mockSessionId, '2-split');
      sessionStore.removeTerminalTab(mockSessionId, '3');
      sessionStore.removeTerminalTab(mockSessionId, '2');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(false);
      expect(terminals!.tiling.layout).toBe('tabbed');
    });

    it('should keep tiling enabled when still compatible', () => {
      sessionStore.addTerminalTab(mockSessionId); // 4 tabs total
      setTilingLayout(mockSessionId, '3-split');
      sessionStore.removeTerminalTab(mockSessionId, '4');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(true);
      expect(terminals!.tiling.layout).toBe('3-split');
    });

    it('should remove tab from tabOrder', () => {
      sessionStore.removeTerminalTab(mockSessionId, '2');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tabOrder).not.toContain('2');
      expect(terminals!.tabOrder).toEqual(['1', '3']);
    });
  });

  describe('addTerminalTab - tabOrder update', () => {
    beforeEach(() => {
      sessionStore.initializeTerminalsForSession(mockSessionId);
    });

    it('should add new tab to end of tabOrder', () => {
      const newTabId = sessionStore.addTerminalTab(mockSessionId);

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tabOrder).toEqual(['1', newTabId]);
    });

    it('should maintain correct tabOrder after multiple adds', () => {
      sessionStore.addTerminalTab(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tabOrder.length).toBe(4);
      expect(terminals!.tabOrder[0]).toBe('1');
    });
  });

  describe('getTilingForSession', () => {
    it('should return null for non-existent session', () => {
      const tiling = getTilingForSession('non-existent');
      expect(tiling).toBeNull();
    });

    it('should return tiling state for initialized session', () => {
      sessionStore.initializeTerminalsForSession(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);
      setTilingLayout(mockSessionId, '2-split');

      const tiling = getTilingForSession(mockSessionId);
      expect(tiling).not.toBeNull();
      expect(tiling!.enabled).toBe(true);
      expect(tiling!.layout).toBe('2-split');
    });
  });

  describe('getTabOrder', () => {
    it('should return null for non-existent session', () => {
      const order = getTabOrder('non-existent');
      expect(order).toBeNull();
    });

    it('should return tab order for initialized session', () => {
      sessionStore.initializeTerminalsForSession(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);

      const order = getTabOrder(mockSessionId);
      expect(order).toEqual(['1', '2']);
    });
  });
});
