import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerPreferencesDeps,
  loadPreferences,
  updateUserPreferences,
  getCurrentPreferences,
} from '../../stores/preferences';

describe('Preferences Store', () => {
  const mockGetPreferences = vi.fn();
  const mockUpdatePreferences = vi.fn();
  const mockLogger = { warn: vi.fn() };
  const mockSetPreferences = vi.fn();
  let storedPrefs = {};

  beforeEach(() => {
    vi.clearAllMocks();
    storedPrefs = {};
    mockSetPreferences.mockImplementation((prefs) => {
      storedPrefs = prefs;
    });
    registerPreferencesDeps({
      api: {
        getPreferences: mockGetPreferences,
        updatePreferences: mockUpdatePreferences,
      },
      logger: mockLogger,
      setPreferences: mockSetPreferences,
      getPreferences: () => storedPrefs,
    });
  });

  describe('loadPreferences', () => {
    it('loads preferences from API and sets them', async () => {
      const prefs = { lastAgentType: 'claude-code' as const, workspaceSyncEnabled: true };
      mockGetPreferences.mockResolvedValue(prefs);

      await loadPreferences();

      expect(mockGetPreferences).toHaveBeenCalled();
      expect(mockSetPreferences).toHaveBeenCalledWith(prefs);
    });

    it('logs warning on failure', async () => {
      mockGetPreferences.mockRejectedValue(new Error('API error'));

      await loadPreferences();

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockSetPreferences).not.toHaveBeenCalled();
    });
  });

  describe('updateUserPreferences', () => {
    it('updates preferences via API and sets them', async () => {
      const updated = { lastAgentType: 'antigravity' as const };
      mockUpdatePreferences.mockResolvedValue(updated);

      await updateUserPreferences({ lastAgentType: 'antigravity' });

      expect(mockUpdatePreferences).toHaveBeenCalledWith({ lastAgentType: 'antigravity' });
      expect(mockSetPreferences).toHaveBeenCalledWith(updated);
    });

    it('logs warning on failure', async () => {
      mockUpdatePreferences.mockRejectedValue(new Error('API error'));

      await updateUserPreferences({ lastAgentType: 'codex' });

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('getCurrentPreferences', () => {
    it('returns current preferences', () => {
      storedPrefs = { lastAgentType: 'bash' as const };

      const result = getCurrentPreferences();

      expect(result).toEqual({ lastAgentType: 'bash' });
    });

    it('returns empty object when no preferences set', () => {
      storedPrefs = {};

      const result = getCurrentPreferences();

      expect(result).toEqual({});
    });
  });
});
