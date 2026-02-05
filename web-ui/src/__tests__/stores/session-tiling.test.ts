import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test the session store's tiling functionality
// These tests will initially fail until we implement the store functions

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

describe('Session Store - Tiling Functionality', () => {
  const mockSessionId = 'test-session-abc123';

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    // Clean up session state
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
      // Add more tabs for reordering tests
      sessionStore.addTerminalTab(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);
    });

    it('should maintain tab 1 in first position', () => {
      // Try to reorder with tab 1 not first - should be rejected or corrected
      const result = sessionStore.reorderTerminalTabs(mockSessionId, ['2', '1', '3']);

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      // Tab 1 should still be first
      expect(terminals!.tabOrder[0]).toBe('1');
    });

    it('should allow reordering tabs 2+ while keeping tab 1 first', () => {
      // Valid reorder: tab 1 first, then 3, then 2
      const result = sessionStore.reorderTerminalTabs(mockSessionId, ['1', '3', '2']);

      expect(result).toBe(true);
      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tabOrder).toEqual(['1', '3', '2']);
    });

    it('should reject orders missing existing tabs', () => {
      // Try to reorder with missing tab
      const result = sessionStore.reorderTerminalTabs(mockSessionId, ['1', '2']);

      // Should reject because tab 3 is missing
      expect(result).toBe(false);
    });

    it('should reject orders with non-existent tabs', () => {
      // Try to add a tab that doesn't exist
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
      sessionStore.setTilingLayout(mockSessionId, '2-split');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(true);
      expect(terminals!.tiling.layout).toBe('2-split');
    });

    it('should disable tiling when setting "tabbed" layout', () => {
      // First enable tiling
      sessionStore.setTilingLayout(mockSessionId, '2-split');

      // Then disable by selecting tabbed
      sessionStore.setTilingLayout(mockSessionId, 'tabbed');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(false);
      expect(terminals!.tiling.layout).toBe('tabbed');
    });

    it('should persist layout to localStorage', () => {
      sessionStore.setTilingLayout(mockSessionId, '2-split');

      const stored = localStorage.getItem('codeflare:terminalsPerSession');
      const parsed = JSON.parse(stored!);
      expect(parsed[mockSessionId].tiling).toEqual({
        enabled: true,
        layout: '2-split',
      });
    });

    it('should return false for incompatible layouts (not enough tabs)', () => {
      // Only 2 tabs, can't use 3-split
      const result = sessionStore.setTilingLayout(mockSessionId, '3-split');

      expect(result).toBe(false);
      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(false);
    });

    it('should allow 2-split with exactly 2 tabs', () => {
      const result = sessionStore.setTilingLayout(mockSessionId, '2-split');

      expect(result).toBe(true);
    });

    it('should allow 3-split with 3+ tabs', () => {
      sessionStore.addTerminalTab(mockSessionId); // Now have 3 tabs

      const result = sessionStore.setTilingLayout(mockSessionId, '3-split');

      expect(result).toBe(true);
      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.layout).toBe('3-split');
    });

    it('should allow 4-grid with 4+ tabs', () => {
      sessionStore.addTerminalTab(mockSessionId); // 3 tabs
      sessionStore.addTerminalTab(mockSessionId); // 4 tabs

      const result = sessionStore.setTilingLayout(mockSessionId, '4-grid');

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
      // Enable 3-split with 3 tabs
      sessionStore.setTilingLayout(mockSessionId, '3-split');

      // Remove a tab, now only 2 tabs - 3-split incompatible, should downgrade to 2-split
      sessionStore.removeTerminalTab(mockSessionId, '3');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      // Should auto-downgrade to 2-split (still enabled) since 2 tabs remain
      expect(terminals!.tiling.enabled).toBe(true);
      expect(terminals!.tiling.layout).toBe('2-split');
    });

    it('should fully disable tiling when removing leaves only 1 tab', () => {
      // Enable 2-split with 3 tabs (only 2 needed)
      sessionStore.setTilingLayout(mockSessionId, '2-split');

      // Remove 2 tabs, leaving only 1 - should disable tiling
      sessionStore.removeTerminalTab(mockSessionId, '3');
      sessionStore.removeTerminalTab(mockSessionId, '2');

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.enabled).toBe(false);
      expect(terminals!.tiling.layout).toBe('tabbed');
    });

    it('should keep tiling enabled when still compatible', () => {
      sessionStore.addTerminalTab(mockSessionId); // 4 tabs total
      sessionStore.setTilingLayout(mockSessionId, '3-split');

      // Remove one tab, still have 3 - should stay in 3-split
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
      expect(terminals!.tabOrder[0]).toBe('1'); // Tab 1 always first
    });

    it('should NOT auto-upgrade tiling layout when new tab exceeds current layout slots', () => {
      // Set up 3-split with 3 tabs
      sessionStore.addTerminalTab(mockSessionId); // 2 tabs
      sessionStore.addTerminalTab(mockSessionId); // 3 tabs
      sessionStore.setTilingLayout(mockSessionId, '3-split');

      // Add a 4th tab — should NOT auto-upgrade to 4-grid
      sessionStore.addTerminalTab(mockSessionId);

      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      // Layout should switch to tabbed (showing new tab), not upgrade to 4-grid
      expect(terminals!.tiling.layout).toBe('tabbed');
      expect(terminals!.tiling.enabled).toBe(false);
    });

    it('should keep tiling layout when new tab fits within current layout slots', () => {
      // Set up 3-split with 2 tabs (extra capacity)
      sessionStore.addTerminalTab(mockSessionId); // 2 tabs
      sessionStore.addTerminalTab(mockSessionId); // 3 tabs
      sessionStore.setTilingLayout(mockSessionId, '3-split');
      sessionStore.addTerminalTab(mockSessionId); // 4 tabs — 3-split only needs 3

      // Add tab should NOT upgrade layout; should switch to tabbed
      const terminals = sessionStore.getTerminalsForSession(mockSessionId);
      expect(terminals!.tiling.layout).toBe('tabbed');
      expect(terminals!.tiling.enabled).toBe(false);
    });
  });

  describe('getTilingForSession', () => {
    it('should return null for non-existent session', () => {
      const tiling = sessionStore.getTilingForSession('non-existent');
      expect(tiling).toBeNull();
    });

    it('should return tiling state for initialized session', () => {
      sessionStore.initializeTerminalsForSession(mockSessionId);
      sessionStore.setTilingLayout(mockSessionId, '2-split');

      // Need at least 2 tabs for 2-split
      sessionStore.addTerminalTab(mockSessionId);
      sessionStore.setTilingLayout(mockSessionId, '2-split');

      const tiling = sessionStore.getTilingForSession(mockSessionId);
      expect(tiling).not.toBeNull();
      expect(tiling!.enabled).toBe(true);
      expect(tiling!.layout).toBe('2-split');
    });
  });

  describe('getTabOrder', () => {
    it('should return null for non-existent session', () => {
      const order = sessionStore.getTabOrder('non-existent');
      expect(order).toBeNull();
    });

    it('should return tab order for initialized session', () => {
      sessionStore.initializeTerminalsForSession(mockSessionId);
      sessionStore.addTerminalTab(mockSessionId);

      const order = sessionStore.getTabOrder(mockSessionId);
      expect(order).toEqual(['1', '2']);
    });
  });
});
