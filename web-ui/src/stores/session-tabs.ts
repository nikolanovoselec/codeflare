import type { SessionTerminals, TerminalTab, TileLayout } from '../types';
import { logger } from '../lib/logger';
import { MAX_TERMINALS_PER_SESSION } from '../lib/constants';
import {
  LAYOUT_MIN_TABS,
  getBestLayoutForTabCount,
  isLayoutCompatible,
} from './tiling';

const TERMINALS_STORAGE_KEY = 'codeflare:terminalsPerSession';

function createTabOne(): TerminalTab {
  return { id: '1', createdAt: new Date().toISOString() };
}

function normalizeSessionTerminals(terminals: SessionTerminals): SessionTerminals {
  const tabMap = new Map<string, TerminalTab>();
  for (const tab of terminals.tabs || []) {
    if (!tab?.id) continue;
    if (!tabMap.has(tab.id)) {
      tabMap.set(tab.id, tab);
    }
  }

  if (!tabMap.has('1')) {
    tabMap.set('1', createTabOne());
  }

  const sourceOrder = terminals.tabOrder && terminals.tabOrder.length > 0
    ? terminals.tabOrder
    : Array.from(tabMap.keys());

  const normalizedOrder: string[] = ['1'];
  for (const tabId of sourceOrder) {
    if (tabId === '1') continue;
    if (!tabMap.has(tabId)) continue;
    if (!normalizedOrder.includes(tabId)) {
      normalizedOrder.push(tabId);
    }
  }

  for (const tabId of tabMap.keys()) {
    if (tabId === '1') continue;
    if (!normalizedOrder.includes(tabId)) {
      normalizedOrder.push(tabId);
    }
  }

  const normalizedTabs = normalizedOrder
    .map((tabId) => tabMap.get(tabId))
    .filter((tab): tab is TerminalTab => Boolean(tab));

  const normalizedActiveTabId = terminals.activeTabId && normalizedOrder.includes(terminals.activeTabId)
    ? terminals.activeTabId
    : '1';

  return {
    tabs: normalizedTabs,
    activeTabId: normalizedActiveTabId,
    tabOrder: normalizedOrder,
    tiling: terminals.tiling || { enabled: false, layout: 'tabbed' },
  };
}

export function loadTerminalsFromStorage(): Record<string, SessionTerminals> {
  try {
    const stored = localStorage.getItem(TERMINALS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, SessionTerminals>;
      if (!parsed || typeof parsed !== 'object') {
        return {};
      }

      const normalized: Record<string, SessionTerminals> = {};
      for (const [sessionId, terminals] of Object.entries(parsed)) {
        if (!terminals || typeof terminals !== 'object') continue;
        if (!Array.isArray(terminals.tabs)) continue;
        normalized[sessionId] = normalizeSessionTerminals(terminals);
      }
      return normalized;
    }
  } catch (err) {
    logger.warn('[SessionStore] Failed to load terminals from storage:', err);
  }
  return {};
}

export function saveTerminalsToStorage(terminalsPerSession: Record<string, SessionTerminals>): void {
  try {
    localStorage.setItem(TERMINALS_STORAGE_KEY, JSON.stringify(terminalsPerSession));
  } catch (err) {
    logger.warn('[SessionStore] Failed to save terminals to storage:', err);
  }
}

type SessionState = {
  terminalsPerSession: Record<string, SessionTerminals>;
};

type StateGetter = () => SessionState;
type StateSetter = (fn: (s: SessionState) => void) => void;
type TerminalStoreRef = {
  dispose: (sessionId: string, terminalId: string) => void;
  disposeSession: (sessionId: string) => void;
  triggerLayoutResize: () => void;
};

let getState: StateGetter;
let setStateFn: StateSetter;
let terminalStoreRef: TerminalStoreRef;
let saveFn: () => void;

export function registerTabsDeps(
  stateGetter: StateGetter,
  stateSetter: StateSetter,
  terminal: TerminalStoreRef,
  save: () => void,
) {
  getState = stateGetter;
  setStateFn = stateSetter;
  terminalStoreRef = terminal;
  saveFn = save;
}

export function initializeTerminalsForSession(sessionId: string): void {
  const state = getState();
  if (state.terminalsPerSession[sessionId]) {
    const normalized = normalizeSessionTerminals(state.terminalsPerSession[sessionId]);
    setStateFn((s) => {
      s.terminalsPerSession[sessionId] = normalized;
    });
    saveFn();
    return;
  }

  const persisted = loadTerminalsFromStorage()[sessionId];
  if (persisted) {
    const normalized = normalizeSessionTerminals(persisted);
    setStateFn((s) => {
      s.terminalsPerSession[sessionId] = normalized;
    });
    saveFn();
    return;
  }

  setStateFn((s) => {
    s.terminalsPerSession[sessionId] = {
      tabs: [{ id: '1', createdAt: new Date().toISOString() }],
      activeTabId: '1',
      tabOrder: ['1'],
      tiling: { enabled: false, layout: 'tabbed' },
    };
  });
  saveFn();
}

export function addTerminalTab(sessionId: string): string | null {
  const state = getState();
  const terminals = state.terminalsPerSession[sessionId];
  if (!terminals || terminals.tabs.length >= MAX_TERMINALS_PER_SESSION) {
    return null;
  }

  const existingIds = new Set(terminals.tabs.map(t => t.id));
  let newId: string | null = null;
  for (let i = 1; i <= MAX_TERMINALS_PER_SESSION; i++) {
    if (!existingIds.has(String(i))) {
      newId = String(i);
      break;
    }
  }

  if (!newId) return null;

  const tabId = newId;

  setStateFn((s) => {
    s.terminalsPerSession[sessionId].tabs.push({
      id: tabId,
      createdAt: new Date().toISOString(),
      manual: true,
    });
    s.terminalsPerSession[sessionId].activeTabId = tabId;
    if (!s.terminalsPerSession[sessionId].tabOrder) {
      s.terminalsPerSession[sessionId].tabOrder = s.terminalsPerSession[sessionId].tabs.map((t: TerminalTab) => t.id);
    } else {
      s.terminalsPerSession[sessionId].tabOrder.push(tabId);
    }

    // When tiling is enabled and the new tab exceeds the current layout's
    // slot count, switch to tabbed view instead of auto-upgrading the layout.
    // The user explicitly chose the current layout; expanding it automatically
    // is surprising and disruptive (e.g., going from 3-split to 4-grid).
    const currentTiling = s.terminalsPerSession[sessionId].tiling;
    if (currentTiling?.enabled) {
      const newTabCount = s.terminalsPerSession[sessionId].tabs.length;
      const currentSlots = LAYOUT_MIN_TABS[currentTiling.layout as TileLayout];
      if (newTabCount > currentSlots) {
        s.terminalsPerSession[sessionId].tiling = {
          enabled: false,
          layout: 'tabbed',
        };
      }
    }
  });
  saveFn();

  if (getState().terminalsPerSession[sessionId]?.tiling?.enabled) {
    terminalStoreRef.triggerLayoutResize();
  }

  return newId;
}

export function removeTerminalTab(sessionId: string, terminalId: string): boolean {
  if (terminalId === '1') {
    return false;
  }

  const state = getState();
  const terminals = state.terminalsPerSession[sessionId];
  if (!terminals || terminals.tabs.length <= 1) {
    return false;
  }

  terminalStoreRef.dispose(sessionId, terminalId);

  setStateFn((s) => {
    const tabs = s.terminalsPerSession[sessionId].tabs;
    s.terminalsPerSession[sessionId].tabs = tabs.filter((t: TerminalTab) => t.id !== terminalId);

    if (s.terminalsPerSession[sessionId].tabOrder) {
      s.terminalsPerSession[sessionId].tabOrder = s.terminalsPerSession[sessionId].tabOrder.filter(
        (id: string) => id !== terminalId
      );
    }

    if (s.terminalsPerSession[sessionId].activeTabId === terminalId) {
      s.terminalsPerSession[sessionId].activeTabId =
        s.terminalsPerSession[sessionId].tabs[0]?.id || null;
    }

    const newTabCount = s.terminalsPerSession[sessionId].tabs.length;
    const currentTiling = s.terminalsPerSession[sessionId].tiling;
    if (currentTiling?.enabled && !isLayoutCompatible(currentTiling.layout as TileLayout, newTabCount)) {
      const downgradedLayout = getBestLayoutForTabCount(newTabCount);
      s.terminalsPerSession[sessionId].tiling = {
        enabled: downgradedLayout !== 'tabbed',
        layout: downgradedLayout,
      };
    }
  });
  saveFn();

  terminalStoreRef.triggerLayoutResize();

  return true;
}

export function setActiveTerminalTab(sessionId: string, terminalId: string): void {
  setStateFn((s) => {
    if (s.terminalsPerSession[sessionId]) {
      s.terminalsPerSession[sessionId].activeTabId = terminalId;
    }
  });
  saveFn();
}

export function getTerminalsForSession(sessionId: string): SessionTerminals | null {
  return getState().terminalsPerSession[sessionId] || null;
}

export function reorderTerminalTabs(sessionId: string, newOrder: string[]): boolean {
  const state = getState();
  const terminals = state.terminalsPerSession[sessionId];
  if (!terminals) return false;

  if (newOrder[0] !== '1') return false;

  const existingIds = new Set(terminals.tabs.map(t => t.id));
  const newIds = new Set(newOrder);

  if (existingIds.size !== newIds.size) return false;

  for (const id of existingIds) {
    if (!newIds.has(id)) return false;
  }

  for (const id of newIds) {
    if (!existingIds.has(id)) return false;
  }

  setStateFn((s) => {
    s.terminalsPerSession[sessionId].tabOrder = [...newOrder];
  });
  saveFn();

  return true;
}

export function updateTerminalLabel(sessionId: string, terminalId: string, processName: string): void {
  setStateFn((s) => {
    const terminals = s.terminalsPerSession[sessionId];
    if (!terminals) return;
    const tab = terminals.tabs.find((t: TerminalTab) => t.id === terminalId);
    if (tab) {
      tab.processName = processName;
    }
  });
}

export function cleanupTerminalsForSession(sessionId: string): void {
  terminalStoreRef.disposeSession(sessionId);

  setStateFn((s) => {
    delete s.terminalsPerSession[sessionId];
  });
  saveFn();
}
