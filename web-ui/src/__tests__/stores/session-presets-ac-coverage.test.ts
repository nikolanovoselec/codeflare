import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * REQ-TERM-010: Session presets (saved tab configurations).
 *
 * ACs 2, 3, 5 are covered by:
 *   - src/__tests__/routes/presets.test.ts (Worker route layer: max-3 enforcement, CRUD)
 *   - web-ui/src/__tests__/stores/session-presets.test.ts (store layer: save/delete/rename)
 *
 * This file covers the gaps:
 *   AC1 - preset shape: saved object has name + tabs fields
 *   AC4 - applyPresetToSession populates session.tabConfig from preset.tabs
 */

// Mock external dependencies before importing the module under test
vi.mock('../../api/client', () => ({
  getPresets: vi.fn(),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
  patchPreset: vi.fn(),
  updateSession: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../stores/terminal', () => ({
  sendInputToTerminal: vi.fn(() => true),
}));

vi.mock('../../lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../stores/session-tabs', () => ({
  initializeTerminalsForSession: vi.fn(),
  saveTerminalsToStorage: vi.fn(),
}));

import * as api from '../../api/client';
import {
  registerPresetsDeps,
  savePreset,
  applyPresetToSession,
} from '../../stores/session-presets';
// Import production types so type drift in SessionWithStatus / TabPreset breaks
// the test compile rather than slipping past a stripped-down local copy.
import type { TabConfig, TabPreset, SessionWithStatus, SessionTerminals } from '../../types';

const mockedApi = vi.mocked(api);

interface SessionState {
  sessions: SessionWithStatus[];
  presets: TabPreset[];
  terminalsPerSession: Record<string, SessionTerminals>;
  error: string | null;
}

function makeSession(id: string, name: string, tabConfig?: TabConfig[]): SessionWithStatus {
  return {
    id,
    name,
    status: 'stopped',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastAccessedAt: '2024-01-01T00:00:00.000Z',
    tabConfig,
  };
}

describe('REQ-TERM-010: Session presets (saved tab configurations)', () => {
  let state: SessionState;
  const getState = () => state;
  const setState = (fn: (s: SessionState) => void) => { fn(state); };
  const setField = (_key: string, value: string) => { state.error = value; };
  const terminalRef = { dispose: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      sessions: [],
      presets: [],
      terminalsPerSession: {},
      error: null,
    };
    registerPresetsDeps(getState, setState, setField, terminalRef);
  });

  // --------------------------------------------------------------------------
  // AC1: Users can save current tab configuration as a preset (name + tabs)
  // --------------------------------------------------------------------------

  describe('AC1: preset object has name and tabs fields', () => {
    it('REQ-TERM-010 AC1: savePreset sends name and tabs to the API and stores the returned preset', async () => {
      const returnedPreset: TabPreset = {
        id: 'p-abc',
        name: 'My Dev Setup',
        tabs: [
          { id: '2', command: 'htop', label: 'Monitor' },
          { id: '3', command: 'bash', label: 'Shell' },
        ],
        createdAt: '2024-06-01T00:00:00.000Z',
      };
      mockedApi.savePreset.mockResolvedValue(returnedPreset);

      const result = await savePreset({
        name: 'My Dev Setup',
        tabs: [
          { id: '2', command: 'htop', label: 'Monitor' },
          { id: '3', command: 'bash', label: 'Shell' },
        ],
      });

      // API was called with name and tabs
      expect(mockedApi.savePreset).toHaveBeenCalledWith({
        name: 'My Dev Setup',
        tabs: [
          { id: '2', command: 'htop', label: 'Monitor' },
          { id: '3', command: 'bash', label: 'Shell' },
        ],
      });
      // Returned preset has name and tabs
      expect(result).not.toBeNull();
      expect(result!.name).toBe('My Dev Setup');
      expect(result!.tabs).toHaveLength(2);
      expect(result!.tabs[0].id).toBe('2');
    });

    it('REQ-TERM-010 AC1: saved preset is appended to state.presets with correct shape', async () => {
      const returnedPreset: TabPreset = {
        id: 'p-xyz',
        name: 'Quick Tools',
        tabs: [{ id: '2', command: 'lazygit', label: 'Git' }],
        createdAt: '2024-06-02T00:00:00.000Z',
      };
      mockedApi.savePreset.mockResolvedValue(returnedPreset);

      await savePreset({ name: 'Quick Tools', tabs: [{ id: '2', command: 'lazygit', label: 'Git' }] });

      expect(state.presets).toHaveLength(1);
      expect(state.presets[0].name).toBe('Quick Tools');
      expect(state.presets[0].tabs).toHaveLength(1);
      expect(state.presets[0].tabs[0].command).toBe('lazygit');
    });
  });

  // --------------------------------------------------------------------------
  // AC4: Apply preset to new session populates tab config
  // --------------------------------------------------------------------------

  describe('AC4: applyPresetToSession populates session.tabConfig from preset.tabs', () => {
    function setupState(sessionId: string, presetId: string, presetTabs: TabConfig[]): void {
      state.sessions = [
        makeSession(sessionId, 'Test Session', [{ id: '1', command: 'claude', label: 'Claude' }]),
      ];
      state.presets = [
        { id: presetId, name: 'Test Preset', tabs: presetTabs, createdAt: '2024-01-01T00:00:00.000Z' },
      ];
      state.terminalsPerSession = {
        [sessionId]: {
          tabs: [{ id: '1', createdAt: '2024-01-01T00:00:00.000Z' }],
          tabOrder: ['1'],
          activeTabId: '1',
          tiling: { enabled: false, layout: 'tabbed' },
        },
      };
    }

    it('REQ-TERM-010 AC4: applyPresetToSession sets session.tabConfig to the preset tabs', async () => {
      const sessionId = 'sess-abc123de';
      const presetId = 'p-1';
      setupState(sessionId, presetId, [
        { id: '2', command: 'htop', label: 'Monitor' },
        { id: '3', command: 'lazygit', label: 'Git' },
      ]);

      const ok = await applyPresetToSession(sessionId, presetId);

      expect(ok).toBe(true);

      // session.tabConfig must include the preset tabs
      const session = state.sessions.find((s) => s.id === sessionId);
      expect(session).toBeDefined();
      const tabIds = session!.tabConfig!.map((t) => t.id);
      expect(tabIds).toContain('2');
      expect(tabIds).toContain('3');
    });

    it('REQ-TERM-010 AC4: tab 1 is always preserved in tabConfig when applying a preset', async () => {
      const sessionId = 'sess-def456ab';
      const presetId = 'p-2';
      setupState(sessionId, presetId, [
        { id: '2', command: 'bash', label: 'Shell' },
      ]);

      await applyPresetToSession(sessionId, presetId);

      const session = state.sessions.find((s) => s.id === sessionId);
      const tabOneConfig = session!.tabConfig!.find((t) => t.id === '1');
      expect(tabOneConfig).toBeDefined();
      // Tab 1 retains its existing command
      expect(tabOneConfig!.command).toBe('claude');
    });

    it('REQ-TERM-010 AC4: applyPresetToSession calls updateSession API with populated tabConfig', async () => {
      const sessionId = 'sess-ghi789cd';
      const presetId = 'p-3';
      setupState(sessionId, presetId, [
        { id: '4', command: 'yazi', label: 'Files' },
      ]);

      await applyPresetToSession(sessionId, presetId);

      expect(mockedApi.updateSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          tabConfig: expect.arrayContaining([
            expect.objectContaining({ id: '1' }),
            expect.objectContaining({ id: '4', command: 'yazi' }),
          ]),
        }),
      );
    });

    it('REQ-TERM-010 AC4: returns false when preset is not found', async () => {
      state.sessions = [makeSession('sess-abc123de', 'S', [])];
      state.presets = [];

      const ok = await applyPresetToSession('sess-abc123de', 'nonexistent-preset');

      expect(ok).toBe(false);
      expect(state.error).toBe('Bookmark not found');
    });

    it('REQ-TERM-010 AC4: returns false when session is not found', async () => {
      state.sessions = [];
      state.presets = [
        { id: 'p-orphan', name: 'Orphan', tabs: [{ id: '2', command: 'bash', label: 'Shell' }], createdAt: '2024-01-01T00:00:00.000Z' },
      ];
      state.terminalsPerSession = {
        'nonexistent-sess': {
          tabs: [],
          tabOrder: [],
          activeTabId: '1',
          tiling: { enabled: false, layout: 'tabbed' },
        },
      };

      const ok = await applyPresetToSession('nonexistent-sess', 'p-orphan');

      expect(ok).toBe(false);
      expect(state.error).toBe('Session not found');
    });
  });
});
