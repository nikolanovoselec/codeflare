import { describe, it, expect } from 'vitest';
import { mdiConsole, mdiFire, mdiRobotOutline, mdiCodeBraces, mdiDiamond, mdiRobotIndustrial } from '@mdi/js';
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

    it('returns robot-industrial icon for "opencode"', () => {
      expect(getTabIcon('opencode')).toBe(mdiRobotIndustrial);
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
      expect(AGENT_ICON_MAP['opencode']).toBe(mdiRobotIndustrial);
      expect(AGENT_ICON_MAP['bash']).toBe(mdiConsole);
    });

    it('has entries for all 6 agent types', () => {
      const expectedAgentTypes = ['claude-unleashed', 'claude-code', 'codex', 'gemini', 'opencode', 'bash'];
      expect(Object.keys(AGENT_ICON_MAP).sort()).toEqual(expectedAgentTypes.sort());
    });

    it('has no extra entries beyond the expected agent types', () => {
      expect(Object.keys(AGENT_ICON_MAP)).toHaveLength(6);
    });

    it('every icon value is a non-empty string (valid SVG path)', () => {
      for (const [agentType, icon] of Object.entries(AGENT_ICON_MAP)) {
        expect(icon, `${agentType} should have a valid icon`).toBeTruthy();
        expect(typeof icon).toBe('string');
        expect(icon.length).toBeGreaterThan(0);
      }
    });
  });

  describe('PROCESS_ICON_MAP exhaustiveness via getTabIcon', () => {
    it('every agent type command resolves to a non-console icon', () => {
      // Agent commands that should have dedicated icons (not fallback console)
      const agentProcessNames = ['claude', 'cu', 'claude-code', 'codex', 'gemini', 'opencode'];
      for (const name of agentProcessNames) {
        const icon = getTabIcon(name);
        expect(icon, `${name} should have a dedicated icon, not fallback`).not.toBe(mdiConsole);
      }
    });

    it('opencode maps to mdiRobotIndustrial in both PROCESS_ICON_MAP and AGENT_ICON_MAP', () => {
      expect(getTabIcon('opencode')).toBe(mdiRobotIndustrial);
      expect(AGENT_ICON_MAP['opencode']).toBe(mdiRobotIndustrial);
      // Both should be the same icon
      expect(getTabIcon('opencode')).toBe(AGENT_ICON_MAP['opencode']);
    });
  });
});
