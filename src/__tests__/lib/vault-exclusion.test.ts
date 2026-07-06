import { describe, it, expect } from 'vitest';
import {
  isVaultExcludedPath,
  parseVaultManifest,
  vaultManifestChanges,
  buildVaultManifest,
  VAULT_MANIFEST_VERSION,
} from '../../../preseed/agents/pi/extensions/memory-vault-helpers';

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

/**
 * Vault-extract change detection is content-hash based, not mtime based, so it
 * survives the R2 restore that rewrites every file's mtime to download-time.
 * These exercise the pure diff/parse/build layer (no fs). The complementary
 * fs-level oracle (touch every file → zero changes) lives in
 * vault-manifest-detection.test.ts.
 */
describe('vaultManifestChanges (content-hash detection)', () => {
  it('returns nothing when every current hash matches the manifest', () => {
    const current = { 'Notes/a.md': 'h1', 'Notes/b.md': 'h2' };
    const manifest = buildVaultManifest(current);
    expect(vaultManifestChanges(current, manifest)).toEqual([]);
  });

  it('is immune to identical content regardless of the manifest object identity', () => {
    // The manifest was persisted last session; the file bytes are unchanged even
    // though (in the real system) the mtime was reset by the R2 restore. Content
    // hash is all that matters, so the diff is empty.
    const manifest = parseVaultManifest(
      JSON.stringify({ version: 1, files: { 'Notes/a.md': 'h1', 'Notes/b.md': 'h2' } }),
    );
    const current = { 'Notes/a.md': 'h1', 'Notes/b.md': 'h2' };
    expect(vaultManifestChanges(current, manifest)).toEqual([]);
  });

  it('reports exactly the file whose bytes changed', () => {
    const manifest = buildVaultManifest({ 'Notes/a.md': 'h1', 'Notes/b.md': 'h2' });
    const current = { 'Notes/a.md': 'h1', 'Notes/b.md': 'CHANGED' };
    expect(vaultManifestChanges(current, manifest)).toEqual(['Notes/b.md']);
  });

  it('reports a brand-new file (absent from the manifest)', () => {
    const manifest = buildVaultManifest({ 'Notes/a.md': 'h1' });
    const current = { 'Notes/a.md': 'h1', 'Notes/new.md': 'h3' };
    expect(vaultManifestChanges(current, manifest)).toEqual(['Notes/new.md']);
  });

  it('does NOT report a deleted file (removed from disk, still in manifest)', () => {
    // A deletion needs no extraction; only new/changed content is work.
    const manifest = buildVaultManifest({ 'Notes/a.md': 'h1', 'Notes/gone.md': 'h2' });
    const current = { 'Notes/a.md': 'h1' };
    expect(vaultManifestChanges(current, manifest)).toEqual([]);
  });

  it('treats an unextracted file from a prior session as changed (no data loss)', () => {
    // Session 1 died before extracting Notes/b.md, so its hash never entered the
    // manifest. Session 2 restores the vault + manifest and must still see it.
    const manifest = buildVaultManifest({ 'Notes/a.md': 'h1' });
    const current = { 'Notes/a.md': 'h1', 'Notes/b.md': 'h2' };
    expect(vaultManifestChanges(current, manifest)).toEqual(['Notes/b.md']);
  });

  it('treats an absent or corrupt manifest as empty (everything reads as new)', () => {
    expect(parseVaultManifest(null).files).toEqual({});
    expect(parseVaultManifest('{not json').files).toEqual({});
    expect(parseVaultManifest('{"version":1}').files).toEqual({});
    const current = { 'Notes/a.md': 'h1' };
    expect(vaultManifestChanges(current, parseVaultManifest(null))).toEqual(['Notes/a.md']);
  });

  it('keeps only string hash entries when parsing a manifest', () => {
    const parsed = parseVaultManifest(
      JSON.stringify({ version: 1, files: { good: 'h1', bad: 42, nested: { x: 1 } } }),
    );
    expect(parsed.files).toEqual({ good: 'h1' });
  });

  it('builds a manifest with the current version and sorted keys', () => {
    const m = buildVaultManifest({ 'z.md': 'h2', 'a.md': 'h1' });
    expect(m.version).toBe(VAULT_MANIFEST_VERSION);
    expect(Object.keys(m.files)).toEqual(['a.md', 'z.md']);
  });
});
