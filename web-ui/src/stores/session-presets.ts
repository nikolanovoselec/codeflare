import type { TabConfig, TabPreset, SessionWithStatus, SessionTerminals } from '../types';
import * as api from '../api/client';
import { sendInputToTerminal } from './terminal';
import { logger } from '../lib/logger';
import { initializeTerminalsForSession, saveTerminalsToStorage } from './session-tabs';

const BOOKMARK_COMMAND_RETRY_ATTEMPTS = 12;
const BOOKMARK_COMMAND_RETRY_DELAY_MS = 250;
const SHELL_PROCESS_NAMES = new Set(['bash', 'sh', 'zsh']);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCommandForTerminal(command: string): string {
  const trimmed = command.trim();
  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
}

async function sendCommandWithRetry(sessionId: string, terminalId: string, command: string): Promise<boolean> {
  const payload = formatCommandForTerminal(command);
  for (let attempt = 1; attempt <= BOOKMARK_COMMAND_RETRY_ATTEMPTS; attempt++) {
    if (sendInputToTerminal(sessionId, terminalId, payload)) {
      return true;
    }
    await wait(BOOKMARK_COMMAND_RETRY_DELAY_MS);
  }
  logger.warn('[SessionStore] Failed to auto-launch bookmark command', {
    sessionId,
    terminalId,
    command: command.trim(),
  });
  return false;
}

type SessionState = {
  sessions: SessionWithStatus[];
  presets: TabPreset[];
  terminalsPerSession: Record<string, SessionTerminals>;
  error: string | null;
};

type StateGetter = () => SessionState;
type StateSetter = (fn: (s: SessionState) => void) => void;
type ErrorSetter = (key: 'error', value: string) => void;
type TerminalStoreRef = {
  dispose: (sessionId: string, terminalId: string) => void;
};

let getState: StateGetter;
let setStateFn: StateSetter;
let setStateField: ErrorSetter;
let terminalStoreRef: TerminalStoreRef;

export function registerPresetsDeps(
  stateGetter: StateGetter,
  stateSetter: StateSetter,
  fieldSetter: ErrorSetter,
  terminal: TerminalStoreRef,
) {
  getState = stateGetter;
  setStateFn = stateSetter;
  setStateField = fieldSetter;
  terminalStoreRef = terminal;
}

export async function loadPresets(): Promise<void> {
  try {
    const presets = await api.getPresets();
    setStateFn((s: SessionState) => { s.presets = presets; });
  } catch (err) {
    logger.warn('[SessionStore] Failed to load presets:', err);
  }
}

export async function savePreset(data: { name: string; tabs: TabConfig[] }): Promise<TabPreset | null> {
  try {
    const preset = await api.savePreset(data);
    setStateFn((s: SessionState) => { s.presets.push(preset); });
    return preset;
  } catch (err) {
    setStateField('error', err instanceof Error ? err.message : 'Failed to save preset');
    return null;
  }
}

export async function deletePreset(id: string): Promise<void> {
  try {
    await api.deletePreset(id);
    setStateFn((s: SessionState) => { s.presets = s.presets.filter((p: TabPreset) => p.id !== id); });
  } catch (err) {
    setStateField('error', err instanceof Error ? err.message : 'Failed to delete preset');
  }
}

export async function renamePreset(id: string, newName: string): Promise<TabPreset | null> {
  const trimmedName = newName.trim();
  if (!trimmedName) {
    setStateField('error', 'Bookmark name cannot be blank');
    return null;
  }

  const state = getState();
  const existing = state.presets.find((p) => p.id === id);
  if (!existing) {
    setStateField('error', 'Bookmark not found');
    return null;
  }

  try {
    const renamed = await api.patchPreset(id, { label: trimmedName });
    setStateFn((s: SessionState) => {
      const idx = s.presets.findIndex((p: TabPreset) => p.id === id);
      if (idx !== -1) {
        s.presets[idx] = renamed;
      }
    });
    return renamed;
  } catch (err) {
    setStateField('error', err instanceof Error ? err.message : 'Failed to rename preset');
    return null;
  }
}

export async function saveBookmarkForSession(sessionId: string, name: string): Promise<TabPreset | null> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    setStateField('error', 'Bookmark name cannot be blank');
    return null;
  }

  const state = getState();
  const terminals = state.terminalsPerSession[sessionId];
  if (!terminals) {
    setStateField('error', 'Session terminals are not ready');
    return null;
  }

  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) {
    setStateField('error', 'Session not found');
    return null;
  }

  const existingTabConfig = new Map((session.tabConfig || []).map((tab) => [tab.id, tab]));
  const terminalTabs = new Map(terminals.tabs.map((tab) => [tab.id, tab]));
  const orderedIds = (terminals.tabOrder && terminals.tabOrder.length > 0
    ? terminals.tabOrder
    : terminals.tabs.map((tab) => tab.id)
  ).filter((id) => /^[2-6]$/.test(id));

  const tabs: TabConfig[] = [];
  for (const tabId of orderedIds) {
    const existing = existingTabConfig.get(tabId);
    const liveTab = terminalTabs.get(tabId);
    const processName = liveTab?.processName?.trim() || '';
    const isShell = SHELL_PROCESS_NAMES.has(processName);
    const command = (existing?.command?.trim() || '') || (processName && !isShell ? processName : '');
    const label = existing?.label || processName || `Terminal ${tabId}`;
    tabs.push({ id: tabId, command, label });
  }

  if (tabs.length === 0) {
    setStateField('error', 'Open at least one tab (2-6) before saving a bookmark');
    return null;
  }

  return savePreset({ name: trimmedName, tabs });
}

export async function applyPresetToSession(sessionId: string, presetId: string): Promise<boolean> {
  const state = getState();
  const preset = state.presets.find((p) => p.id === presetId);
  if (!preset) {
    setStateField('error', 'Bookmark not found');
    return false;
  }

  if (!state.terminalsPerSession[sessionId]) {
    initializeTerminalsForSession(sessionId);
  }

  const terminals = getState().terminalsPerSession[sessionId];
  if (!terminals) {
    setStateField('error', 'Session terminals are not ready');
    return false;
  }

  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) {
    setStateField('error', 'Session not found');
    return false;
  }

  const seenTabIds = new Set<string>();
  const presetTabs = preset.tabs
    .filter((tab) => /^[2-6]$/.test(tab.id))
    .filter((tab) => {
      if (seenTabIds.has(tab.id)) return false;
      seenTabIds.add(tab.id);
      return true;
    });

  const existingTabOneConfig = session.tabConfig?.find((tab) => tab.id === '1');
  const liveTabOne = terminals.tabs.find((tab) => tab.id === '1');
  const fullTabConfig: TabConfig[] = [
    {
      id: '1',
      command: existingTabOneConfig?.command || '',
      label: existingTabOneConfig?.label || liveTabOne?.processName || 'Terminal 1',
    },
    ...presetTabs,
  ];
  const desiredTabOrder = ['1', ...presetTabs.map((tab) => tab.id)];
  const terminalIdsToDispose = terminals.tabs
    .map((tab) => tab.id)
    .filter((tabId) => !desiredTabOrder.includes(tabId));

  terminalIdsToDispose.forEach((tabId) => terminalStoreRef.dispose(sessionId, tabId));

  setStateFn((s: SessionState) => {
    const sessionTerminals = s.terminalsPerSession[sessionId];
    if (!sessionTerminals) return;

    sessionTerminals.tabs = desiredTabOrder.map((tabId: string) => {
      const existing = sessionTerminals.tabs.find((tab) => tab.id === tabId);
      return existing || { id: tabId, createdAt: new Date().toISOString() };
    });
    sessionTerminals.tabOrder = [...desiredTabOrder];
    if (!sessionTerminals.activeTabId || !desiredTabOrder.includes(sessionTerminals.activeTabId)) {
      sessionTerminals.activeTabId = '1';
    }

    const sessionIndex = s.sessions.findIndex((existingSession) => existingSession.id === sessionId);
    if (sessionIndex !== -1) {
      s.sessions[sessionIndex].tabConfig = fullTabConfig;
    }
  });

  saveTerminalsToStorage(getState().terminalsPerSession);

  try {
    await api.updateSession(sessionId, { tabConfig: fullTabConfig });
  } catch (err) {
    logger.warn('[SessionStore] Failed to persist bookmark tab config:', err);
    setStateField('error', err instanceof Error ? err.message : 'Failed to update session tab configuration');
  }

  const launchTargets = presetTabs
    .map((tab) => ({ tabId: tab.id, command: tab.command.trim() }))
    .filter((tab) => tab.command.length > 0);
  await Promise.all(launchTargets.map((target) => sendCommandWithRetry(sessionId, target.tabId, target.command)));

  return true;
}
