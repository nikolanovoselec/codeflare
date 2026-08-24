import { describe, expect, it } from 'vitest';
import { SessionWorkspaceSchema, resolveSessionWorkspace } from '../../types';

describe('REQ-IDE-051 AC4: session workspace contract', () => {
  it('accepts only Terminal and VS Code workspace values', () => {
    expect(SessionWorkspaceSchema.parse('terminal')).toBe('terminal');
    expect(SessionWorkspaceSchema.parse('vscode')).toBe('vscode');
    expect(SessionWorkspaceSchema.safeParse('browser').success).toBe(false);
  });

  it('resolves missing and historical unknown values to Terminal', () => {
    expect(resolveSessionWorkspace(undefined)).toBe('terminal');
    expect(resolveSessionWorkspace(null)).toBe('terminal');
    expect(resolveSessionWorkspace('browser')).toBe('terminal');
  });

  it('retains an explicit VS Code workspace', () => {
    expect(resolveSessionWorkspace('vscode')).toBe('vscode');
  });
});
