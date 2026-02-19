import { describe, it, expect } from 'vitest';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { AgentTypeSchema } from '../../types';
import type { AgentType } from '../../types';
import { MAX_TABS } from '../../lib/constants';

/**
 * Expected command mapping for every agent type.
 * Kept in sync with AGENT_COMMANDS in agent-config.ts.
 */
const EXPECTED_COMMANDS: Record<AgentType, { command: string; label: string }> = {
  'claude-code': { command: 'claude', label: 'Terminal 1' },
  'claude-unleashed': { command: 'cu', label: 'Terminal 1' },
  'codex': { command: 'codex', label: 'Terminal 1' },
  'gemini': { command: 'gemini', label: 'Terminal 1' },
  'opencode': { command: 'opencode', label: 'Terminal 1' },
  'bash': { command: '', label: 'Terminal 1' },
};

describe('AGENT_COMMANDS exhaustiveness', () => {
  const allAgentTypes = AgentTypeSchema.options;

  it('every AgentType in the schema has a valid tab config (no runtime error)', () => {
    for (const agentType of allAgentTypes) {
      expect(() => getDefaultTabConfig(agentType)).not.toThrow();
    }
  });

  it('schema contains exactly the expected agent types', () => {
    const expected = ['claude-unleashed', 'claude-code', 'codex', 'gemini', 'opencode', 'bash'];
    expect([...allAgentTypes].sort()).toEqual([...expected].sort());
  });

  it.each(Object.entries(EXPECTED_COMMANDS))(
    'agent "%s" maps to command "%s" with label "%s"',
    (agentType, { command, label }) => {
      const tabs = getDefaultTabConfig(agentType as AgentType);
      expect(tabs[0].command).toBe(command);
      expect(tabs[0].label).toBe(label);
    },
  );
});

describe('getDefaultTabConfig', () => {
  it('returns MAX_TABS tabs', () => {
    const tabs = getDefaultTabConfig('claude-code');
    expect(tabs).toHaveLength(MAX_TABS);
  });

  it('sets tab 1 to the agent command for claude-code', () => {
    const tabs = getDefaultTabConfig('claude-code');
    expect(tabs[0]).toEqual({ id: '1', command: 'claude', label: 'Terminal 1' });
  });

  it('sets tab 1 to cu for claude-unleashed', () => {
    const tabs = getDefaultTabConfig('claude-unleashed');
    expect(tabs[0].command).toBe('cu');
  });

  it('sets tab 1 to codex for codex agent', () => {
    const tabs = getDefaultTabConfig('codex');
    expect(tabs[0].command).toBe('codex');
  });

  it('sets tab 1 to gemini for gemini agent', () => {
    const tabs = getDefaultTabConfig('gemini');
    expect(tabs[0].command).toBe('gemini');
  });

  it('sets tab 1 to opencode for opencode agent', () => {
    const tabs = getDefaultTabConfig('opencode');
    expect(tabs[0].command).toBe('opencode');
  });

  it('sets tab 1 label to "Terminal 1" for opencode agent', () => {
    const tabs = getDefaultTabConfig('opencode');
    expect(tabs[0].label).toBe('Terminal 1');
  });

  it('returns correct full structure for opencode agent', () => {
    const tabs = getDefaultTabConfig('opencode');
    expect(tabs[0]).toEqual({ id: '1', command: 'opencode', label: 'Terminal 1' });
  });

  it('sets tab 1 to empty command for bash agent', () => {
    const tabs = getDefaultTabConfig('bash');
    expect(tabs[0].command).toBe('');
  });

  it('sets tabs 2-6 to empty bash terminals', () => {
    const tabs = getDefaultTabConfig('claude-code');
    for (let i = 1; i < tabs.length; i++) {
      expect(tabs[i]).toEqual({
        id: String(i + 1),
        command: '',
        label: `Terminal ${i + 1}`,
      });
    }
  });

  it('generates correct tab IDs as strings', () => {
    const tabs = getDefaultTabConfig('bash');
    const ids = tabs.map(t => t.id);
    expect(ids).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});
