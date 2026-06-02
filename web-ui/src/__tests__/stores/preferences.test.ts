import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerPreferencesDeps,
  loadPreferences,
  updateUserPreferences,
} from '../../stores/preferences';

describe('Preferences Store', () => {
  const mockGetPreferences = vi.fn();
  const mockUpdatePreferences = vi.fn();
  const mockLogger = { warn: vi.fn() };
  const mockSetPreferences = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    registerPreferencesDeps({
      api: {
        getPreferences: mockGetPreferences,
        updatePreferences: mockUpdatePreferences,
      },
      logger: mockLogger,
      setPreferences: mockSetPreferences,
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
});
