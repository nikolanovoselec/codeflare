import { describe, it, expect } from 'vitest';
import { mdiConsole, mdiFire, mdiRobotOutline, mdiCodeBraces, mdiDiamond } from '@mdi/js';
import { TERMINAL_TAB_CONFIG, getTabIcon, AGENT_ICON_MAP } from '../../lib/terminal-config';

describe('terminal-config', () => {
  describe('TERMINAL_TAB_CONFIG', () => {
    it('defines configs for tabs 1 through 6', () => {
      for (let i = 1; i <= 6; i++) {
        const config = TERMINAL_TAB_CONFIG[String(i)];
        expect(config).toBeTruthy();
        expect(config.name).toBe(`Terminal ${i}`);
        expect(config.icon).toBe(mdiConsole);
      }
    });
  });

  describe('getTabIcon', () => {
    it('returns fire icon for "claude"', () => {
      expect(getTabIcon('claude')).toBe(mdiFire);
    });

    it('returns fire icon for "cu"', () => {
      expect(getTabIcon('cu')).toBe(mdiFire);
    });

    it('returns robot icon for "claude-code"', () => {
      expect(getTabIcon('claude-code')).toBe(mdiRobotOutline);
    });

    it('returns codex icon for "codex"', () => {
      expect(getTabIcon('codex')).toBe(mdiCodeBraces);
    });

    it('returns diamond icon for "gemini"', () => {
      expect(getTabIcon('gemini')).toBe(mdiDiamond);
    });

    it('returns console icon for shell processes', () => {
      expect(getTabIcon('bash')).toBe(mdiConsole);
      expect(getTabIcon('sh')).toBe(mdiConsole);
      expect(getTabIcon('zsh')).toBe(mdiConsole);
    });

    it('returns console icon as fallback for unknown processes', () => {
      expect(getTabIcon('unknown-process')).toBe(mdiConsole);
      expect(getTabIcon('')).toBe(mdiConsole);
    });
  });

  describe('AGENT_ICON_MAP', () => {
    it('maps agent types to their icons', () => {
      expect(AGENT_ICON_MAP['claude-unleashed']).toBe(mdiFire);
      expect(AGENT_ICON_MAP['claude-code']).toBe(mdiRobotOutline);
      expect(AGENT_ICON_MAP['codex']).toBe(mdiCodeBraces);
      expect(AGENT_ICON_MAP['gemini']).toBe(mdiDiamond);
      expect(AGENT_ICON_MAP['bash']).toBe(mdiConsole);
    });
  });
});
