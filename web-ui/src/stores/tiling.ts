import type { TileLayout, TilingState, SessionTerminals } from '../types';
import { terminalStore } from './terminal';

/** Shape of the session store state that tiling.ts needs access to */
interface SessionStoreState {
  terminalsPerSession: Record<string, SessionTerminals>;
}

// Lazy reference to session store state — avoids circular import at module load time.
// Populated by session.ts via registerSessionStoreAccess() during module initialization.
let _getState: (() => SessionStoreState) | null = null;
let _setState: ((fn: (s: SessionStoreState) => void) => void) | null = null;
let _saveTerminals: (() => void) | null = null;

/**
 * Called by session.ts to provide access to the session store's state/setState.
 * This avoids circular imports while letting tiling.ts read/write session state.
 */
export function registerSessionStoreAccess(
  getState: () => SessionStoreState,
  setState: (fn: (s: SessionStoreState) => void) => void,
  saveTerminals: () => void,
): void {
  _getState = getState;
  _setState = setState;
  _saveTerminals = saveTerminals;
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum tab counts required for each tiling layout */
export const LAYOUT_MIN_TABS: Record<TileLayout, number> = {
  tabbed: 1,
  '2-split': 2,
  '3-split': 3,
  '4-grid': 4,
};

/** Layout upgrade hierarchy: when tab count matches a higher layout, auto-upgrade */
export const LAYOUT_UPGRADE_ORDER: TileLayout[] = ['tabbed', '2-split', '3-split', '4-grid'];

// ============================================================================
// Helpers
// ============================================================================

/** Get the best layout for a given tab count (highest layout that the tab count supports) */
export function getBestLayoutForTabCount(tabCount: number): TileLayout {
  let best: TileLayout = 'tabbed';
  for (const layout of LAYOUT_UPGRADE_ORDER) {
    if (tabCount >= LAYOUT_MIN_TABS[layout]) {
      best = layout;
    }
  }
  return best;
}

/** Check if layout is compatible with tab count */
export function isLayoutCompatible(layout: TileLayout, tabCount: number): boolean {
  const minTabs = LAYOUT_MIN_TABS[layout];
  return minTabs !== undefined && tabCount >= minTabs;
}

// ============================================================================
// API functions (read/write session store state)
// ============================================================================

/** Set tiling layout for a session */
export function setTilingLayout(sessionId: string, layout: TileLayout): boolean {
  if (!_getState || !_setState || !_saveTerminals) {
    throw new Error('Session store access not registered. Call registerSessionStoreAccess() first.');
  }

  const terminals = _getState().terminalsPerSession[sessionId];
  if (!terminals) return false;

  const tabCount = terminals.tabs.length;

  // Validate layout compatibility
  if (!isLayoutCompatible(layout, tabCount)) return false;

  _setState((s: SessionStoreState) => {
    s.terminalsPerSession[sessionId].tiling = {
      enabled: layout !== 'tabbed',
      layout,
    };
  });
  _saveTerminals();

  // Trigger terminal resize for all tiled terminals after layout change
  // This ensures TUI apps (htop, yazi, etc.) receive SIGWINCH and redraw
  terminalStore.triggerLayoutResize();

  return true;
}

/** Get tiling state for a session */
export function getTilingForSession(sessionId: string): TilingState | null {
  if (!_getState) return null;
  const terminals = _getState().terminalsPerSession[sessionId];
  return terminals?.tiling || null;
}

/** Get tab order for a session */
export function getTabOrder(sessionId: string): string[] | null {
  if (!_getState) return null;
  const terminals = _getState().terminalsPerSession[sessionId];
  const raw = terminals?.tabOrder || null;
  if (!raw) return null;
  const order = [...raw];
  if (order[0] !== '1') {
    const idx = order.indexOf('1');
    if (idx > 0) {
      order.splice(idx, 1);
      order.unshift('1');
    }
  }
  return order;
}
