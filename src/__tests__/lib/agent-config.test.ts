import { describe, it, expect } from 'vitest';
import { getDefaultTabConfig } from '../../lib/agent-config';
import type { AgentType } from '../../types';
import { MAX_TABS } from '../../lib/constants';

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
