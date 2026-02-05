import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API client
vi.mock('../../api/client', () => ({
  getPresets: vi.fn(),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
  patchPreset: vi.fn(),
}));

vi.mock('../../stores/terminal', () => ({
  sendInputToTerminal: vi.fn(() => true),
}));

vi.mock('../../lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Must mock session-tabs before importing session-presets
vi.mock('../../stores/session-tabs', () => ({
  initializeTerminalsForSession: vi.fn(),
  saveTerminalsToStorage: vi.fn(),
}));

import * as api from '../../api/client';
import {
  registerPresetsDeps,
  loadPresets,
  savePreset,
  deletePreset,
  renamePreset,
} from '../../stores/session-presets';

const mockedApi = vi.mocked(api);

describe('session-presets store', () => {
  let state: {
    sessions: any[];
    presets: any[];
    terminalsPerSession: Record<string, any>;
    error: string | null;
  };
  const getState = () => state;
  const setState = (fn: (s: typeof state) => void) => { fn(state); };
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

  describe('loadPresets', () => {
    it('fetches presets from API and stores them', async () => {
      const mockPresets = [
        { id: 'p1', name: 'Dev Setup', tabs: [{ id: '2', command: 'htop', label: 'Monitor' }], createdAt: '2024-01-01' },
      ];
      mockedApi.getPresets.mockResolvedValue(mockPresets);

      await loadPresets();

      expect(mockedApi.getPresets).toHaveBeenCalled();
      expect(state.presets).toEqual(mockPresets);
    });

    it('does not throw on API failure', async () => {
      mockedApi.getPresets.mockRejectedValue(new Error('Network error'));

      await expect(loadPresets()).resolves.not.toThrow();
    });
  });

  describe('savePreset', () => {
    it('saves a preset and appends to state', async () => {
      const newPreset = { id: 'p2', name: 'New', tabs: [], createdAt: '2024-01-02' };
      mockedApi.savePreset.mockResolvedValue(newPreset);

      const result = await savePreset({ name: 'New', tabs: [] });

      expect(result).toEqual(newPreset);
      expect(state.presets).toContainEqual(newPreset);
    });

    it('sets error on API failure and returns null', async () => {
      mockedApi.savePreset.mockRejectedValue(new Error('Save failed'));

      const result = await savePreset({ name: 'Fail', tabs: [] });

      expect(result).toBeNull();
      expect(state.error).toBe('Save failed');
    });
  });

  describe('deletePreset', () => {
    it('removes preset from state after API delete', async () => {
      state.presets = [
        { id: 'p1', name: 'A', tabs: [], createdAt: '2024-01-01' },
        { id: 'p2', name: 'B', tabs: [], createdAt: '2024-01-02' },
      ];
      mockedApi.deletePreset.mockResolvedValue(undefined);

      await deletePreset('p1');

      expect(state.presets).toHaveLength(1);
      expect(state.presets[0].id).toBe('p2');
    });

    it('sets error on API failure', async () => {
      mockedApi.deletePreset.mockRejectedValue(new Error('Delete failed'));

      await deletePreset('p1');

      expect(state.error).toBe('Delete failed');
    });
  });

  describe('renamePreset', () => {
    it('renames a preset in state', async () => {
      state.presets = [
        { id: 'p1', name: 'Old Name', tabs: [], createdAt: '2024-01-01' },
      ];
      const renamed = { id: 'p1', name: 'New Name', tabs: [], createdAt: '2024-01-01' };
      mockedApi.patchPreset.mockResolvedValue(renamed);

      const result = await renamePreset('p1', 'New Name');

      expect(result).toEqual(renamed);
      expect(state.presets[0].name).toBe('New Name');
    });

    it('rejects blank names', async () => {
      const result = await renamePreset('p1', '   ');

      expect(result).toBeNull();
      expect(state.error).toBe('Bookmark name cannot be blank');
    });

    it('rejects unknown preset IDs', async () => {
      state.presets = [];

      const result = await renamePreset('nonexistent', 'Name');

      expect(result).toBeNull();
      expect(state.error).toBe('Bookmark not found');
    });
  });
});
