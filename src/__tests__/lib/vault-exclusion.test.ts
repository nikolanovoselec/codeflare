import { describe, it, expect } from 'vitest';
import { isVaultExcludedPath } from '../../../preseed/agents/pi/extensions/memory-vault-helpers';

/**
 * REQ-VAULT — generated graph artifacts must not trigger vault-extract.
 *
 * The self-trigger loop: vault-extract re-renders Raw/Graphs/vault-graph.html on every
 * run (extractor step 6), which then looked newer than the just-advanced marker and
 * re-spawned the agent next turn. The fix is excluding that generated path; these tests
 * fail if the exclusion list regresses (e.g. the Raw/Graphs entry is removed) or if the
 * prefix match degrades from segment-aware to naive substring matching.
 */
const VAULT = '/home/user/Vault';

describe('isVaultExcludedPath', () => {
  it('excludes the served viz copy that caused the self-trigger loop', () => {
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Raw/Graphs/vault-graph.html')).toBe(true);
  });

  it('excludes graphify-out artifacts', () => {
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/graphify-out/graph.json')).toBe(true);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/graphify-out/vault-graph.json')).toBe(true);
  });

  it('excludes agent-owned memory-capture sessions', () => {
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Raw/Sessions/2026-06-08-foo.md')).toBe(true);
  });

  it('excludes boot-preseeded SilverBullet plug bundles', () => {
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Library/Codeflare/treeview.plug.js')).toBe(true);
  });

  it('excludes editor-managed metadata', () => {
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/.silverbullet/index.db')).toBe(true);
  });

  it('excludes codeflare-authoritative root pages', () => {
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Index.md')).toBe(true);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/README.md')).toBe(true);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/CONFIG.md')).toBe(true);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/STYLES.md')).toBe(true);
  });

  it('excludes a path that resolves outside the vault root', () => {
    expect(isVaultExcludedPath(VAULT, '/home/user/elsewhere.md')).toBe(true);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/../secret.md')).toBe(true);
  });

  it('does NOT exclude real user notes', () => {
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Notes/foo.md')).toBe(false);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Inbox/today.md')).toBe(false);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Journal/2026-06-08.md')).toBe(false);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/References/paper.md')).toBe(false);
  });

  it('matches by path segment, not substring (no false exclusions)', () => {
    // "Rawthoughts" must not match the "Raw/Sessions" / "Raw/Graphs" prefixes,
    // and a sibling of Library/Codeflare must stay included.
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Rawthoughts/note.md')).toBe(false);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/Library/MyNotes/x.md')).toBe(false);
    expect(isVaultExcludedPath(VAULT, '/home/user/Vault/graphify-output-notes/x.md')).toBe(false);
  });
});
