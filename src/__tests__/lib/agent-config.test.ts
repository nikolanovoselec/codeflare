import { describe, it, expect } from 'vitest';
import { getDefaultTabConfig } from '../../lib/agent-config';
import { AgentTypeSchema } from '../../types';
import type { AgentType } from '../../types';

/**
 * Expected command mapping for every agent type.
 * Kept in sync with AGENT_COMMANDS in agent-config.ts.
 */
const EXPECTED_COMMANDS: Record<AgentType, { command: string; label: string }> = {
  'claude-code': { command: 'claude --dangerously-skip-permissions', label: 'Terminal 1' },
  'codex': { command: 'codex', label: 'Terminal 1' },
  'copilot': { command: 'copilot --yolo', label: 'Terminal 1' },
  'antigravity': { command: 'agy --dangerously-skip-permissions', label: 'Terminal 1' },
  'opencode': { command: 'opencode', label: 'Terminal 1' },
  'pi': { command: 'pi', label: 'Terminal 1' },
  'bash': { command: '', label: 'Terminal 1' },
};

describe('AGENT_COMMANDS exhaustiveness / REQ-AGENT-001 AC1/AC2 (seven agent types: claude-code, codex, copilot, antigravity, opencode, pi, bash; enforced via AgentTypeSchema)', () => {
  const allAgentTypes = AgentTypeSchema.options;

  it('every AgentType in the schema has a valid tab config (no runtime error)', () => {
    for (const agentType of allAgentTypes) {
      expect(() => getDefaultTabConfig(agentType)).not.toThrow();
    }
  });

  it('schema contains exactly the expected agent types', () => {
    const expected = ['claude-code', 'codex', 'copilot', 'antigravity', 'opencode', 'pi', 'bash'];
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

describe('getDefaultTabConfig / REQ-AGENT-002 AC1/AC2/AC5 (POST /api/sessions accepts agentType field, validated against AgentTypeSchema, defaults to claude-code)', () => {
  it('returns only the primary configuration consumed by the Herdr launcher', () => {
    expect(getDefaultTabConfig('claude-code')).toHaveLength(1);
  });

  it('sets tab 1 to the agent command for claude-code', () => {
    const tabs = getDefaultTabConfig('claude-code');
    expect(tabs[0]).toEqual({ id: '1', command: 'claude --dangerously-skip-permissions', label: 'Terminal 1' });
  });

  it('sets tab 1 to codex for codex agent', () => {
    const tabs = getDefaultTabConfig('codex');
    expect(tabs[0].command).toBe('codex');
  });

  it('sets tab 1 to antigravity for antigravity agent', () => {
    const tabs = getDefaultTabConfig('antigravity');
    expect(tabs[0].command).toBe('agy --dangerously-skip-permissions');
  });

  it('sets tab 1 to copilot for copilot agent', () => {
    const tabs = getDefaultTabConfig('copilot');
    expect(tabs[0].command).toBe('copilot --yolo');
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

  it('sets tab 1 to pi for pi agent', () => {
    const tabs = getDefaultTabConfig('pi');
    expect(tabs[0].command).toBe('pi');
  });

  it('sets tab 1 to empty command for bash agent', () => {
    const tabs = getDefaultTabConfig('bash');
    expect(tabs[0].command).toBe('');
  });

  it('uses only internal terminal ID 1', () => {
    expect(getDefaultTabConfig('bash').map((tab) => tab.id)).toEqual(['1']);
  });
});
